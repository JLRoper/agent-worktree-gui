// The board draws the trees cut from another one UNDER it: this harness proves that on a real board, read only.
//
//   PANEL_BASE=http://127.0.0.1:7331 node tools/verify-child-rows.mjs
//   node tools/verify-child-rows.mjs --base http://127.0.0.1:7391
//
// WHAT THIS GUARDS. `row.parent` / `row.parentSource` (lib/parents.js) say which branch a tree was cut from. The
// board now draws that record instead of only describing it in a chip's tooltip: a row whose parent is another row of
// the same project hangs under it, one indent in, keeps every cell it had (its own branch, its own verdict, its own
// actions), and the parent carries a fold that puts the whole group out of sight.
//
// The check is against the INSTANCE's own data, not a fixture: it reads /api/state, derives every recorded child,
// and then asserts the DOM agrees — each child that can hang under a parent is drawn immediately under it and
// indented, each child whose parent is not on the chart is drawn on its own row, and no child is lost. The two
// groups the landing was asked to prove are named in the output (Menu's children of feature/menu-oauth2-gateway, and
// fleet-kafka's of dev) with their real counts, because a branch cut or removed between runs must show up as a number
// that moved rather than as a silent pass.
//
// FOLDING. One child is opened first, so it has a detail of its own, and the node is stamped. The parent's ▾ is then
// pressed three times with a different thing proved each time:
//   1. folded   — every child (and the detail hanging under it) is out of sight, the parent is still on screen, and
//                 the child's own nodes are STILL IN THE DOCUMENT (a fold is a class, not a removal);
//   2. unfolded — the same nodes are back, the stamp survives, and the child's chips are byte-for-byte what they
//                 were: folding cannot have lost the row's state, because nothing rebuilt it;
//   3. folded again, then the project is re-rendered from state — the group comes back FOLDED, which is what proves
//                 the fold lives in `state.foldedParents` and not in the class a previous paint happened to leave.
//
// READ ONLY, and proved so: the harness issues GETs and drives the page's own client gestures. It never posts, never
// starts a run and never asks the panel to change a worktree. The page itself posts /api/project/open when the reader
// unfolds a project (that is the panel's own "read this project now"), so the no-write assertion is scoped to the
// fold press, where nothing at all may leave the browser.
//
// HARNESS: LIVE GATE. Exits 0 only when every check passes; a page error or a console error fails the run too.
import path from "node:path";
import { mkdirSync } from "node:fs";
import os from "node:os";
import { loadPlaywright, withBrowser } from "./browser.mjs";

const BASE = (argValue("--base") || process.env.PANEL_BASE || "http://127.0.0.1:7331").replace(/\/+$/, "");
const SHOTS = process.env.CHILD_ROWS_SHOTS || path.join(os.tmpdir(), "wag-child-rows");

function argValue(flag) {
  const at = process.argv.indexOf(flag);
  return at > -1 ? process.argv[at + 1] : null;
}

let failures = 0;
let checks = 0;
function check(name, got, want) {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
}
function ok(name, cond, extra = "") {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
const note = (text) => console.log(`      ${text}`);
const keyOf = (project, p) => `${project}::${p}`;
// Node has no `CSS.escape`. Every selector built OUTSIDE the page uses this: a row key is a project name and a path,
// and the only characters that can end the attribute value early are a quote and a backslash.
const cssEsc = (s) => String(s).replace(/["\\]/g, "\\$&");

// The recorded children of one instance, from its own snapshot. A child "hangs" when its parent is another row of the
// same project (that is the only case a row can be drawn under), so every other recorded child — a parent that has
// since been removed, a branch that belongs to another repository — is expected to stay on its own row.
function childrenOf(snapshot) {
  const projects = new Map();
  for (const p of snapshot.projects || []) {
    const rows = p.worktrees || [];
    const byBranch = new Map();
    for (const r of rows) {
      const b = String(r.branch || "").trim();
      if (b && !byBranch.has(b)) byBranch.set(b, r);
    }
    const children = [];
    for (const r of rows) {
      const parent = String(r.parent || "").trim();
      if (!parent) continue;
      const pr = byBranch.get(parent) || null;
      children.push({
        project: p.name,
        path: r.path,
        branch: r.branch,
        key: keyOf(p.name, r.path),
        parentBranch: parent,
        parentSource: r.parentSource || "unknown",
        parentKey: pr && keyOf(p.name, pr.path) !== keyOf(p.name, r.path) ? keyOf(p.name, pr.path) : null,
      });
    }
    projects.set(p.name, { name: p.name, rows, children });
  }
  return projects;
}

async function waitFor(fn, { timeoutMs = 120_000, stepMs = 250, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// The instance's first pass is not instant (177 projects, a git read per worktree). A snapshot taken mid-scan would
// under-count the children and the harness would "pass" against half a board, so the model is read only once the
// row count has stopped moving: `<rows>|<recorded children>` unchanged over four reads, with a real board behind it.
async function settledSnapshot() {
  const until = Date.now() + 300_000;
  let last = "";
  let stable = 0;
  for (;;) {
    const snap = await (await fetch(`${BASE}/api/state`)).json();
    let rows = 0;
    let kids = 0;
    for (const p of snap.projects || []) {
      for (const w of p.worktrees || []) {
        rows += 1;
        if (String(w.parent || "").trim()) kids += 1;
      }
    }
    const sig = `${rows}|${kids}`;
    stable = sig === last ? stable + 1 : 0;
    last = sig;
    if (stable >= 3 && rows >= 100) return snap;
    if (Date.now() > until) {
      throw new Error(`the instance never settled its first scan (${rows} rows, ${kids} recorded children) — let it finish a pass and run again`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// The board's own rows for one project, in DOM order, as keys — details and confirmations are not rows and are not
// in this list, so "the child is the next row after its parent" is answered by this.
async function drawnKeys(page, project) {
  return page.evaluate((name) => {
    const sec = document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`);
    const tbody = sec?.querySelector("tbody");
    return [...(tbody?.children || [])].filter((el) => el.classList.contains("row")).map((el) => el.dataset.key);
  }, project);
}

async function openProject(page, project) {
  const collapsed = await page.evaluate(
    (name) => document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`)?.classList.contains("collapsed") ?? true,
    project,
  );
  if (!collapsed) return;
  await page.evaluate((name) => {
    document.querySelector(`section.project[data-project="${CSS.escape(name)}"] .project-head[data-toggle-project]`)?.click();
  }, project);
  await waitFor(
    () =>
      page.evaluate(
        (name) => !document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`)?.classList.contains("collapsed"),
        project,
      ),
    { timeoutMs: 20_000, what: `${project} to unfold` },
  );
}

// The chart draws the top N rows and one arrow lists the rest. Every row of this project has to be on the chart for
// the grouping to be judged, so the arrow is pressed when it is there — the page's own gesture, nothing else.
async function showEveryRow(page, project) {
  const pressed = await page.evaluate((name) => {
    const btn = document.querySelector(`[data-age-toggle="${CSS.escape(name)}"]`);
    if (!btn) return false;
    btn.click();
    return true;
  }, project);
  if (pressed) await new Promise((r) => setTimeout(r, 400));
  return pressed;
}

async function rowInfo(page, key) {
  return page.evaluate((k) => {
    const tr = document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`);
    if (!tr) return null;
    const name = tr.querySelector("td.name");
    const line = tr.querySelector("td.name .name-line");
    const nameEl = tr.querySelector("td.name .row-name");
    const fold = tr.querySelector(".btn-row-fold");
    const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
    return {
      classes: [...tr.classList],
      parentKey: tr.dataset.parentKey || null,
      depth: tr.dataset.depth || null,
      nameLeft: nameEl ? Math.round(nameEl.getBoundingClientRect().left) : null,
      padLeft: name ? Math.round(Number.parseFloat(getComputedStyle(name).paddingLeft)) : null,
      lineVisible: Boolean(line && line.getClientRects().length),
      fold: fold
        ? {
            expanded: fold.getAttribute("aria-expanded"),
            glyph: fold.textContent.trim(),
            label: fold.getAttribute("aria-label"),
            title: fold.title,
            visible: Boolean(fold.getClientRects().length),
          }
        : null,
      chips: {
        branch: tr.querySelector("td.branch")?.textContent.trim() || null,
        verdict: tr.querySelector("td.verdict")?.textContent.trim() || null,
        actions: [...tr.querySelectorAll("td.row-actions button")].map((b) => b.dataset.delTree ? "del" : b.dataset.refreshTree ? "refresh" : b.dataset.childTree ? "child" : "?").sort(),
      },
      cells: cells.length,
    };
  }, key);
}

async function main() {
  let snapshot;
  try {
    snapshot = await settledSnapshot();
  } catch (e) {
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(String((e && e.message) || e) + String((e && e.cause && e.cause.code) || ""))) {
      console.log(`PANEL-HALF-NOT-RUN  no panel answers at ${BASE} — start one (node server.js, or set PANEL_BASE) and run again`);
      process.exit(2);
    }
    throw e;
  }
  if (!Array.isArray(snapshot.projects)) throw new Error(`${BASE}/api/state carried no projects — is the panel up?`);
  const model = childrenOf(snapshot);
  const all = [...model.values()].flatMap((p) => p.children);
  const hanging = all.filter((c) => c.parentKey);
  const orphaned = all.filter((c) => !c.parentKey);
  note(`instance ${BASE}: ${snapshot.projects.length} project(s), ${all.length} recorded child row(s)`);
  note(`${hanging.length} have their parent on this board (they can hang); ${orphaned.length} do not, and must stay on their own row`);

  // The brief's two named groups, with the instance's real counts: a branch cut or removed between runs moves a number
  // here instead of quietly passing.
  const menu = model.get("Menu") || { children: [] };
  const fleet = model.get("fleet-kafka") || { children: [] };
  const menuGroup = menu.children.filter((c) => c.parentBranch === "feature/menu-oauth2-gateway");
  const fleetGroup = fleet.children.filter((c) => c.parentBranch === "dev");
  note(`Menu · feature/menu-oauth2-gateway: ${menuGroup.length} child(ren) [${menuGroup.map((c) => c.branch).join(", ")}]`);
  note(`fleet-kafka · dev: ${fleetGroup.length} child(ren) [${fleetGroup.map((c) => c.branch).join(", ")}]`);
  ok("the board carries the children the brief named", all.length >= 20 && menuGroup.length >= 4 && fleetGroup.length >= 3, `${all.length} recorded, ${menuGroup.length} under Menu's turnover branch, ${fleetGroup.length} under dev`);
  ok("at least one child per named group can hang under its parent", menuGroup.some((c) => c.parentKey) && fleetGroup.some((c) => c.parentKey));

  mkdirSync(SHOTS, { recursive: true });
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log("BROWSER-HALF-NOT-RUN  no Playwright install found — set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright");
    process.exit(2);
  }

  const verdict = await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("#projects section.project", { timeout: 120_000 });

      // ---- 1. every project that owns a hanging child is unfolded, and its chart shows every row -------------
      const projectsToOpen = [...new Set(hanging.map((c) => c.project))].filter((name) => model.has(name));
      for (const name of projectsToOpen) {
        await openProject(page, name);
        await showEveryRow(page, name);
      }
      await waitFor(
        () =>
          page.evaluate(
            (names) => names.every((n) => Boolean(document.querySelector(`section.project[data-project="${CSS.escape(n)}"] tbody tr.row`))),
            projectsToOpen,
          ),
        { timeoutMs: 120_000, what: "the opened projects to draw their rows" },
      );
      // A group is drawn as its parent, then (in any order) its own descendants. `descendantsOf` is what "under it"
      // means: every key reached by following the child edges down from the folded parent.
      const descendantsOf = (key) => {
        const out = [];
        const walk = (k) => {
          for (const c of hanging) {
            if (c.parentKey !== k) continue;
            out.push(c.key);
            walk(c.key);
          }
        };
        walk(key);
        return out;
      };
      await waitFor(
        () =>
          page.evaluate(
            (keys) => keys.every((k) => Boolean(document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`))),
            hanging.map((c) => c.parentKey).concat(hanging.map((c) => c.key)),
          ),
        { timeoutMs: 120_000, what: "the recorded parents and children to be drawn" },
      );

      // ---- 2. the shape: each child is the next row under its parent, indented, with its own cells -----------
      let nestedSeen = 0;
      let indentBad = [];
      let orderBad = [];
      let ownCellsBad = [];
      for (const child of hanging) {
        const keys = await drawnKeys(page, child.project);
        const at = keys.indexOf(child.key);
        const parentAt = keys.indexOf(child.parentKey);
        if (at < 0 || parentAt < 0) continue; // held back by the chart: reported below
        nestedSeen += 1;
        const info = await rowInfo(page, child.key);
        const parentInfo = await rowInfo(page, child.parentKey);
        if (info.parentKey !== child.parentKey || !info.classes.includes("is-child")) orderBad.push(`${child.branch} (parent attr ${info.parentKey})`);
        // The parent is followed by its own descendants and nothing else, before this child.
        const own = new Set(descendantsOf(child.parentKey));
        const between = keys.slice(parentAt + 1, at).filter((k) => !own.has(k));
        if (at <= parentAt || between.length) orderBad.push(`${child.branch} (at ${at}, parent ${parentAt}, strays ${between.join(",")})`);
        if (!(info.padLeft > parentInfo.padLeft && info.nameLeft > parentInfo.nameLeft)) {
          indentBad.push(`${child.branch} (pad ${info.padLeft} vs ${parentInfo.padLeft}, x ${info.nameLeft} vs ${parentInfo.nameLeft})`);
        }
        // Its own chips and its own actions: the child is not drawn as a caption of the parent.
        if (!info.chips.branch || !info.chips.verdict || info.chips.actions.length < 2 || info.cells !== parentInfo.cells) {
          ownCellsBad.push(`${child.branch} (branch "${info.chips.branch}", verdict "${info.chips.verdict}", actions ${info.chips.actions.join("+") || "none"}, ${info.cells} cells)`);
        }
      }
      ok("every child that can hang is drawn with a parent key", nestedSeen > 0 && orderBad.length === 0, `${nestedSeen} nested${orderBad.length ? ` — ${orderBad.join("; ")}` : ""}`);
      ok("every child is indented under its parent", indentBad.length === 0, indentBad.join("; ") || `${nestedSeen} row(s) compared`);
      ok("every child keeps its own branch, verdict, actions and column count", ownCellsBad.length === 0, ownCellsBad.join("; ") || `${nestedSeen} row(s) compared`);

      // ---- 3. a child whose parent is NOT on the chart keeps its own row (the chart's top-N case) ------------
      let topLevelOk = 0;
      let topLevelBad = [];
      for (const child of orphaned) {
        const keys = await drawnKeys(page, child.project);
        if (!keys.includes(child.key)) continue;
        const info = await rowInfo(page, child.key);
        if (info.parentKey || info.classes.includes("is-child")) topLevelBad.push(`${child.project} · ${child.branch} hangs from ${info.parentKey}`);
        else topLevelOk += 1;
      }
      ok("a child with no parent row on the chart is drawn on its own row, never indented", topLevelBad.length === 0, topLevelBad.join("; ") || `${topLevelOk} drawn child(ren) with no parent on the chart`);

      // ---- 4. the fold: hide, restore, and survive a rebuild ------------------------------------------------
      const groupProject = menuGroup.some((c) => c.parentKey) ? "Menu" : hanging[0].project;
      const group = (groupProject === "Menu" ? menuGroup : hanging).filter((c) => c.parentKey);
      const parentKey = group[0].parentKey;
      const groupKids = descendantsOf(parentKey);
      note(`folding ${parentKey} — ${groupKids.length} child(ren) under it`);

      // The parent's fold control exists, is on screen, and says how many it holds.
      const before = await rowInfo(page, parentKey);
      ok("the parent row carries a fold control", Boolean(before.fold && before.fold.visible), JSON.stringify(before.fold));
      check("the fold control starts unfolded", before.fold?.expanded, "true");
      ok("the fold control names its group", /worktree/.test(before.fold?.title || "") && String(before.fold?.label || "").includes("hide"), before.fold?.title);

      // Open ONE child so it has state of its own to lose: a detail, with the row marked expanded.
      const probeKey = groupKids[0];
      await page.click(`#projects tr.row[data-key="${cssEsc(probeKey)}"] td.name .row-name`);
      const detailSel = `#projects tr.detail[data-detail="${cssEsc(probeKey)}"]`;
      await page.waitForSelector(detailSel, { timeout: 20_000 });
      const childBefore = await rowInfo(page, probeKey);
      const childHandle = await page.$(`#projects tr.row[data-key="${cssEsc(probeKey)}"]`);
      const detailHandle = await page.$(detailSel);
      await page.evaluate(
        ([k]) => {
          const tr = document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`);
          const d = document.querySelector(`#projects tr.detail[data-detail="${CSS.escape(k)}"]`);
          if (tr) tr.dataset.kept = "child-row";
          if (d) d.dataset.kept = "child-detail";
        },
        [probeKey],
      );
      const chipsBefore = JSON.stringify(childBefore.chips);
      ok("the child opened a detail of its own before the fold", Boolean(detailHandle), detailSel.split("#projects ")[1]);

      // No request may leave the page for a fold: it is a picture, not a command. (A GET the page runs on its own
      // clock is not the fold's doing, so only a write fails this; writes are what "nothing leaves the browser" means.)
      const during = [];
      const watch = (req) => during.push(`${req.method()} ${req.url()}`);
      page.on("request", watch);
      const shots = { open: path.join(SHOTS, "child-group-open.png"), folded: path.join(SHOTS, "child-group-folded.png") };
      await page.screenshot({ path: shots.open, fullPage: false });

      await page.click(`#projects tr.row[data-key="${cssEsc(parentKey)}"] .btn-row-fold`);
      await new Promise((r) => setTimeout(r, 350));
      const foldedInfo = await rowInfo(page, parentKey);
      const hiddenKids = await page.evaluate(
        (keys) => keys.map((k) => {
          const tr = document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`);
          const d = document.querySelector(`#projects tr.detail[data-detail="${CSS.escape(k)}"]`);
          return {
            key: k,
            row: tr ? Boolean(tr.getClientRects().length) : null,
            inDoc: Boolean(tr && tr.isConnected),
            kept: tr?.dataset.kept || null,
            detail: d ? Boolean(d.getClientRects().length) : null,
            detailInDoc: d ? Boolean(d.isConnected) : null,
            detailKept: d?.dataset.kept || null,
          };
        }),
        groupKids,
      );
      await page.screenshot({ path: shots.folded, fullPage: false });
      page.off("request", watch);

      check("the fold flipped its own control", foldedInfo.fold?.expanded, "false");
      ok("every child of the folded parent is out of sight", hiddenKids.every((k) => k.row === false), JSON.stringify(hiddenKids.map((k) => [k.key.split("::")[1].split("/").pop(), k.row])));
      ok("the children stay in the document — a fold hides, it does not remove", hiddenKids.every((k) => k.inDoc === true));
      const probe = hiddenKids.find((k) => k.key === groupKids[0]);
      ok("the folded child's own panel is kept, hidden, with the stamp on it", probe?.detail === false && probe?.detailInDoc === true && probe?.detailKept === "child-detail" && probe?.kept === "child-row", JSON.stringify(probe));
      ok("the parent row stays on screen", Boolean((await rowInfo(page, parentKey))?.lineVisible));
      check("a fold writes nothing to the panel", during.filter((r) => !r.startsWith("GET ")), []);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("wtgui.foldedParents") || "[]"));
      ok("the fold is remembered in the reader's own book", stored.includes(parentKey), JSON.stringify(stored));

      // ---- 5. unfolding gives back the SAME nodes, chips untouched ---------------------------------------
      await page.click(`#projects tr.row[data-key="${cssEsc(parentKey)}"] .btn-row-fold`);
      await new Promise((r) => setTimeout(r, 350));
      const backInfo = await rowInfo(page, probeKey);
      check("the fold control flipped back", (await rowInfo(page, parentKey)).fold?.expanded, "true");
      const childStillSame = childHandle ? await childHandle.evaluate((el) => el.isConnected && el.dataset.kept === "child-row") : false;
      const detailStillSame = detailHandle ? await detailHandle.evaluate((el) => el.isConnected && el.dataset.kept === "child-detail" && Boolean(el.getClientRects().length)) : false;
      ok("the child row is the very node it was before the fold", Boolean(childStillSame));
      ok("the child's detail is the very node, still open, after the fold", Boolean(detailStillSame));
      check("the child's chips are unchanged by the fold", JSON.stringify(backInfo.chips), chipsBefore);
      ok("the child is on screen again under its parent", backInfo.lineVisible && backInfo.parentKey === parentKey);

      // ---- 6. the fold lives in state, not in a class a paint left behind --------------------------------
      await page.click(`#projects tr.row[data-key="${cssEsc(parentKey)}"] .btn-row-fold`);
      await new Promise((r) => setTimeout(r, 250));
      await page.evaluate((name) => renderProjectRows(name), groupProject);
      await new Promise((r) => setTimeout(r, 400));
      const afterRebuild = await page.evaluate(
        (keys) => keys.map((k) => {
          const tr = document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`);
          return { key: k, visible: tr ? Boolean(tr.getClientRects().length) : null };
        }),
        groupKids,
      );
      const parentAfter = await rowInfo(page, parentKey);
      ok("a rebuild comes back folded — the fold is state, not markup", afterRebuild.every((k) => k.visible === false) && parentAfter.fold?.expanded === "false", JSON.stringify(afterRebuild));
      await page.click(`#projects tr.row[data-key="${cssEsc(parentKey)}"] .btn-row-fold`);
      await new Promise((r) => setTimeout(r, 300));
      const reopened = await page.evaluate(
        (keys) => keys.map((k) => Boolean(document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`)?.getClientRects().length)),
        groupKids,
      );
      ok("and opens again after the rebuild", reopened.every(Boolean), JSON.stringify(reopened));

      // ---- 7. the second named group, the same fold ------------------------------------------------
      const fleetParent = fleetGroup.find((c) => c.parentKey)?.parentKey || null;
      if (fleetParent) {
        const fleetKids = descendantsOf(fleetParent);
        const fleetInfo = await rowInfo(page, fleetParent);
        ok("fleet-kafka's dev row carries a fold naming its children", Boolean(fleetInfo.fold) && /cut from dev/.test(fleetInfo.fold.title), `${fleetKids.length} child(ren): ${fleetInfo.fold?.title}`);
        await page.click(`#projects tr.row[data-key="${cssEsc(fleetParent)}"] .btn-row-fold`);
        await new Promise((r) => setTimeout(r, 300));
        const fleetHidden = await page.evaluate(
          (keys) => keys.map((k) => Boolean(document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`)?.getClientRects().length)),
          fleetKids,
        );
        await page.click(`#projects tr.row[data-key="${cssEsc(fleetParent)}"] .btn-row-fold`);
        await new Promise((r) => setTimeout(r, 300));
        const fleetBack = await page.evaluate(
          (keys) => keys.map((k) => Boolean(document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`)?.getClientRects().length)),
          fleetKids,
        );
        ok("fleet-kafka's children fold away and come back", fleetHidden.every((v) => v === false) && fleetBack.every(Boolean), `hidden ${JSON.stringify(fleetHidden)} back ${JSON.stringify(fleetBack)}`);
      } else {
        ok("fleet-kafka's children fold away and come back", false, "no dev child could hang — the group is not on the chart");
      }

      // ---- 8. one level deeper: a tree cut from a CHILD steps in again, and an outer fold hides the chain -----
      // This instance has no grandchild today. The chain is seeded in the PAGE's own state — a browser-local copy the
      // panel is never told about — and the project is re-rendered, which is the only way to prove the recursion
      // without inventing a worktree on disk. The two probe rows are dropped and the project re-rendered afterwards.
      const chainProbe = { mid: `${groupProject}::probe/child-rows/step-two`, leaf: `${groupProject}::probe/child-rows/step-three` };
      const seeded = await page.evaluate(
        ({ project, parentKey, probe: chainProbe }) => {
          const base = state.rows.get(parentKey);
          if (!base) return null;
          const childKey = [...state.rows.keys()].find((k) => k.startsWith(`${project}::`) && state.rows.get(k)?.parent === base.branch);
          if (!childKey) return null;
          const child = state.rows.get(childKey);
          const mk = (key, path, branch, parent) => state.rows.set(key, { ...child, path, branch, name: path.split("/").pop(), parent, parentSource: "cut" });
          mk(chainProbe.mid, "probe/child-rows/step-two", "probe/step-two", base.branch);
          mk(chainProbe.leaf, "probe/child-rows/step-three", "probe/step-three", "probe/step-two");
          renderProjectRows(project);
          return { childKey };
        },
        { project: groupProject, parentKey, probe: chainProbe },
      );
      if (seeded) {
        const mid = await rowInfo(page, chainProbe.mid);
        const leaf = await rowInfo(page, chainProbe.leaf);
        ok("a tree cut from a child hangs under the child, one indent deeper", mid.parentKey === parentKey && mid.depth === "1" && leaf.parentKey === chainProbe.mid && leaf.depth === "2" && leaf.padLeft > mid.padLeft, JSON.stringify({ mid: [mid.parentKey, mid.depth, mid.padLeft], leaf: [leaf.parentKey, leaf.depth, leaf.padLeft] }));
        ok("the child carries its own fold for the tree cut from it", Boolean(mid.fold) && /cut from probe\/step-two/.test(mid.fold.title), mid.fold?.title);
        await page.click(`#projects tr.row[data-key="${cssEsc(chainProbe.mid)}"] .btn-row-fold`);
        await new Promise((r) => setTimeout(r, 250));
        const leafHidden = await page.evaluate((k) => !document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`)?.getClientRects().length, chainProbe.leaf);
        const midStill = await page.evaluate((k) => Boolean(document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`)?.getClientRects().length), chainProbe.mid);
        await page.click(`#projects tr.row[data-key="${cssEsc(chainProbe.mid)}"] .btn-row-fold`);
        await new Promise((r) => setTimeout(r, 250));
        ok("folding the child hides only the tree under it", leafHidden && midStill);
        // The OUTER fold hides the whole chain, grandchild included.
        await page.click(`#projects tr.row[data-key="${cssEsc(parentKey)}"] .btn-row-fold`);
        await new Promise((r) => setTimeout(r, 300));
        const chain = await page.evaluate(
          (keys) => keys.map((k) => Boolean(document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`)?.getClientRects().length)),
          [chainProbe.mid, chainProbe.leaf],
        );
        await page.click(`#projects tr.row[data-key="${cssEsc(parentKey)}"] .btn-row-fold`);
        await new Promise((r) => setTimeout(r, 300));
        ok("the outer fold hides the whole chain, not only the first step", chain.every((v) => v === false), JSON.stringify(chain));
        const cleaned = await page.evaluate(
          ({ project, probe: chainProbe }) => {
            state.rows.delete(chainProbe.mid);
            state.rows.delete(chainProbe.leaf);
            renderProjectRows(project);
            return !document.querySelector(`#projects tr.row[data-key="${CSS.escape(chainProbe.mid)}"]`) && !document.querySelector(`#projects tr.row[data-key="${CSS.escape(chainProbe.leaf)}"]`);
          },
          { project: groupProject, probe },
        );
        ok("the probe rows left the page again", cleaned);
      } else {
        ok("a tree cut from a child hangs under the child, one indent deeper", false, "could not seed a chain on this board");
      }

      // ---- 9. the page stayed healthy, and nothing was written ---------------------------------------
      check("no page errors", pageErrors, []);
      check("no console errors", consoleErrors, []);

      return {
        nestedSeen,
        topLevelOk,
        groupProject,
        parentKey,
        groupKids: groupKids.length,
        shots,
      };
    },
    { viewport: { width: 1760, height: 1000 }, deviceScaleFactor: 1 },
  );

  note(`screenshots: ${verdict.shots.open} · ${verdict.shots.folded}`);
  console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} checks · ${all.length} recorded children · ${verdict.nestedSeen} drawn nested`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(`HARNESS-ERROR ${(e && e.stack) || e}`);
  process.exit(1);
});
