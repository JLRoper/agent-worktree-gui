// Lane C: pin the branch cell and the PR cell against the panel's own GET /api/state.
//
// READ-ONLY against the panel. It loads the board in headless Chromium, expands every project so the rows
// exist in the DOM, and compares each row's cells with the same row in /api/state. It never posts, never
// restarts the server, never touches its logs, and never mutates product state: the one synthetic row it draws
// (the "no branch" state) is pushed into the page's own `state` in memory and is labelled as a fixture in the
// report, because no live row currently has an empty branch.
//
//   node harness/playwright-lane-c/verify.mjs [--base http://127.0.0.1:7331] [--out <dir>] [--project <name>]
//
// Exit code is 0 when every pinned check passes, 1 otherwise (the report carries the detail either way).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Where playwright lives, and what to say when it does not: one bootstrap for every harness (tools/browser.mjs)
// instead of a copy of the lookup in each file.
import { loadPlaywright, notRun } from "../../tools/browser.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.base || "http://127.0.0.1:7331";
const OUT = args.out || "C:/CodeReviews/agent-worktree-gui/playwright-lane-c";
const PROJECT = args.project || "agent-worktree-gui";
const SHOT_DIR = OUT;
mkdirSync(SHOT_DIR, { recursive: true });

const results = { base: BASE, startedAt: new Date().toISOString(), pinned: [], sweep: null, refresh: [], fixture: null, failures: [] };

// ---- the API is the reference ----------------------------------------------------------------
async function getState() {
  const r = await fetch(`${BASE}/api/state`);
  if (!r.ok) throw new Error(`GET /api/state -> HTTP ${r.status}`);
  return r.json();
}
const state = await getState();
const rowKey = (p, w) => `${p}::${w.path}`;
const byKey = new Map();
for (const p of state.projects || []) for (const w of p.worktrees || []) byKey.set(rowKey(p.name, w), { project: p, row: w });

// ---- the page --------------------------------------------------------------------------------
const playwright = loadPlaywright();
if (!playwright) {
  console.log(notRun("the branch and PR cells", "no Playwright install found — set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright"));
  process.exit(2);
}
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1760, height: 1000 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => results.failures.push({ where: "page", error: String(e) }));
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("section.project", { timeout: 30000 });
// A section is in the DOM before its head is drawn: the skeleton is `<section class="project collapsed">` and the
// toggle arrives with the first render. Clicking any earlier is a no-op that reads as "everything is already open".
await page.waitForSelector("section.project [data-toggle-project]", { timeout: 30000 });

// Every project section has to be open, or its `tr.row`s are not in the DOM at all.
async function expandAll() {
  let total = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const n = await page.evaluate(() => {
      let opened = 0;
      for (const sec of document.querySelectorAll("section.project.collapsed")) {
        const head = sec.querySelector("[data-toggle-project]");
        if (head) {
          head.click();
          opened += 1;
        }
      }
      return opened;
    });
    total += n;
    if (!n) break;
    await page.waitForTimeout(900);
  }
  return total;
}
const opened = await expandAll();
results.openedSections = opened;
await page.waitForFunction(() => document.querySelectorAll("tr.row").length > 0, null, { timeout: 30000 });

// A row whose last activity is older than the age threshold is not built at all. The legend's arrow is the
// reader's own control for showing those, so it is pressed everywhere before a row is called missing.
async function revealStale() {
  let total = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const n = await page.evaluate(() => {
      let pressed = 0;
      for (const btn of document.querySelectorAll("[data-age-toggle]")) {
        if (btn.getAttribute("aria-pressed") !== "true") {
          btn.click();
          pressed += 1;
        }
      }
      return pressed;
    });
    total += n;
    if (!n) break;
    await page.waitForTimeout(900);
  }
  return total;
}
results.revealedStaleRows = await revealStale();

// The cells, read as the reader sees them: the text, the href, the chip and its tooltip.
async function readCells(keys) {
  return page.evaluate((wanted) => {
    const out = {};
    for (const key of wanted) {
      const tr = [...document.querySelectorAll("tr.row")].find((t) => t.dataset.key === key);
      if (!tr) {
        out[key] = null;
        continue;
      }
      const b = tr.querySelector("td.branch");
      const pr = tr.querySelectorAll("td")[5];
      const link = b?.querySelector("a.branch-link") || null;
      const plain = b?.querySelector(".branch-plain") || null;
      // TWO words live in this cell: `local` (the remote's own denial) and `unverified` (the panel could not ask it).
      // The chip readers below treat them apart, because "an unknown row never reads as local" is a check about the
      // WORD, not about the presence of a marker — the row has to say something either way.
      const chip = b?.querySelector(".branch-local, .branch-unverified") || null;
      const chipStyle = chip ? getComputedStyle(chip) : null;
      out[key] = {
        branch: {
          text: (link?.textContent || plain?.textContent || "").trim(),
          html: (b?.innerHTML || "").slice(0, 500),
          href: link?.getAttribute("href") || null,
          title: (link || plain)?.getAttribute("title") || "",
          chipText: chip ? chip.textContent.trim() : null,
          chipLocal: Boolean(chip && chip.classList.contains("branch-local")),
          chipVisibleText: chip && chipStyle ? (chipStyle.textTransform === "uppercase" ? chip.textContent.trim().toUpperCase() : chip.textContent.trim()) : null,
          chipTitle: chip?.getAttribute("title") || null,
          saysLocal: [...(b?.querySelectorAll("span, a") || [])].some((el) => el.textContent.trim().toLowerCase() === "local"),
        },
        pr: {
          text: (pr?.textContent || "").replace(/\s+/g, " ").trim(),
          href: pr?.querySelector("a")?.getAttribute("href") || null,
          cls: pr?.querySelector("a")?.className || pr?.firstElementChild?.className || null,
          title: pr?.querySelector("a, span")?.getAttribute("title") || "",
          html: (pr?.innerHTML || "").slice(0, 500),
        },
      };
    }
    return out;
  }, keys);
}

// ---- the four states, chosen from the API ----------------------------------------------------
const eq = (a, b) => String(a) === String(b);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const wanted = (pred) => [...byKey.entries()].filter(([, v]) => pred(v.project, v.row));
const existsRows = wanted((p, w) => w.remoteBranch === "exists" && w.branchUrl);
const goneRows = wanted((p, w) => w.remoteBranch === "gone" && w.branchLocalOnly === true);
const unknownRows = wanted((p, w) => w.remoteBranch === "unknown");
const prRows = wanted((p, w) => w.pr && w.prUrl);
const pick = (list, pred = () => true) => list.find(([k, v]) => v.project.name === PROJECT && pred(v)) || list.find(([k, v]) => pred(v));

// A worktree row, not the project's own checkout: the primary tree's `main` is a row too, but it is not the
// "a branch with a remote copy" a worktree column is read for.
const isWorktree = (v) => norm(v.row.path) !== norm(v.project.path);
const existsPick = pick(existsRows, (v) => v.row.pr && isWorktree(v)) || pick(existsRows, isWorktree) || existsRows[0];
const gonePick = pick(goneRows, (v) => String(v.row.path).includes("playwright-lane-c")) || goneRows[0];
// The unknown state has two shapes in the same API answer, and they draw differently: no local ref either (plain
// text, the "cannot tell" sentence, and the `unverified` chip) and a ref in refs/remotes from the last fetch (a link
// whose tooltip says the remote itself was not asked, and no chip at all). Both are pinned, because the brief's chip
// has to be judged in both. A row whose project carries a `fetchNote` is preferred for the plain shape: the chip's
// sentence is supposed to QUOTE that note, and a project that has never failed a fetch has nothing to quote.
const byNote = (a, b) => String(a[1].project.fetchNote || "").length - String(b[1].project.fetchNote || "").length;
const unknownPlainRows = unknownRows.filter(([, v]) => !v.row.branchUrl).sort(byNote);
const unknownPlain = unknownPlainRows.find(([, v]) => String(v.project.fetchNote || "").trim()) || unknownPlainRows[0] || null;
const unknownLink = unknownRows.find(([, v]) => v.row.branchUrl) || null;
const prPick = prRows.find(([, v]) => isWorktree(v)) || prRows[0];

// A state the board does not offer is REPORTED, not thrown on. `gonePick[0]` on an undefined pick is a TypeError, and
// that is exactly what a board whose every branch is pushed — or one with no worktree at all — used to get instead of
// a verdict. The unknown pins were conditional from the start; every pin is now, and the run says which states it
// could not judge instead of passing a half it never saw.
const SKIPPED = [];
const pin = (id, pick, kind, expect) => {
  if (!pick) {
    SKIPPED.push({ id, why: `no row on this board is in the \`${id}\` state` });
    return [];
  }
  return [{ id, kind, key: pick[0], expect }];
};

const PINNED = [
  ...pin("exists", existsPick, "exists", "a link to the branch page, no local chip"),
  ...pin("gone", gonePick, "gone", "a LOCAL chip and the sentence that the remote does not list it"),
  ...(unknownPlain
    ? [{ id: "unknown", kind: "unknown-plain", key: unknownPlain[0], expect: "an UNVERIFIED chip quoting the project's fetchNote, never a local chip" }]
    : []),
  ...(unknownLink
    ? [{ id: "unknown-link", kind: "unknown-link", key: unknownLink[0], expect: "no local chip; the link says the remote itself was not asked" }]
    : []),
];
if (!unknownPlain && !unknownLink) SKIPPED.push({ id: "unknown", why: "no row on this board is in the `unknown` state" });

const api = Object.fromEntries(PINNED.map((p) => [p.key, byKey.get(p.key)]));

// ---- checks ----------------------------------------------------------------------------------
const checks = (ok, what, expected, actual) => ({ ok: Boolean(ok), what, expected, actual });

const before = await readCells(PINNED.map((p) => p.key));
const shots = [];

// The board rebuilds a project's tbody on every scan, so a locator resolved a moment ago can be detached by the
// time the shutter opens: re-resolve and retry rather than reporting a render bug that is really a repaint.
async function shoot(key, kind, file) {
  const row = `tr.row[data-key="${key.replace(/["\\]/g, "\\$&")}"]`;
  const cell = kind === "branch" ? `${row} > td.branch` : `${row} > td:nth-child(6)`;
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const loc = page.locator(cell).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
      await page.waitForTimeout(120);
      await loc.screenshot({ path: path.join(SHOT_DIR, file), animations: "disabled", timeout: 8000 });
      shots.push(file);
      return true;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(350);
    }
  }
  results.failures.push({ where: "screenshot", file, error: String(lastErr && lastErr.message) });
  return false;
}

for (const pin of PINNED) {
  const a = api[pin.key];
  const cell = before[pin.key];
  const name = a.row.branch;
  const entries = [];
  if (!cell) {
    entries.push(checks(false, `${pin.id}: the row is on the board`, "tr.row with the API's key", `no row for ${pin.key}`));
  } else if (pin.kind === "exists") {
    entries.push(checks(cell.branch.href !== null, "the branch is a link", "an <a class=\"branch-link\">", cell.branch.html.slice(0, 120)));
    entries.push(checks(eq(cell.branch.href, a.row.branchUrl), "the link is the API's branchUrl", a.row.branchUrl, cell.branch.href));
    entries.push(
      checks(
        eq(cell.branch.href, `https://github.com/JLRoper/agent-worktree-gui/tree/${name}`),
        "the link resolves to the GitHub tree page for the branch",
        `https://github.com/JLRoper/agent-worktree-gui/tree/${name}`,
        cell.branch.href,
      ),
    );
    entries.push(checks(eq(cell.branch.text, name), "the cell names the branch", name, cell.branch.text));
    entries.push(checks(!cell.branch.saysLocal && !cell.branch.chipText, "no local chip on a remote-backed branch", "no chip", `chip=${JSON.stringify(cell.branch.chipText)} saysLocal=${cell.branch.saysLocal}`));
  } else if (pin.kind === "gone") {
    entries.push(checks(cell.branch.href === null, "no link when the remote does not list the branch", "no <a>", cell.branch.href));
    entries.push(checks(cell.branch.chipText !== null, "the LOCAL chip is drawn", "a .branch-local chip", cell.branch.html.slice(0, 160)));
    entries.push(checks(eq(norm(cell.branch.chipVisibleText), "LOCAL"), "the chip reads LOCAL", "LOCAL", cell.branch.chipVisibleText));
    entries.push(checks(eq(norm(cell.branch.text), norm(name)), "the cell names the branch", name, cell.branch.text));
    entries.push(checks(/^local only/.test(norm(cell.branch.chipTitle)), "the chip's sentence says the remote does not have it", "local only — …", cell.branch.chipTitle));
    entries.push(
      checks(
        /the remote origin does not list it/.test(norm(cell.branch.chipTitle)),
        "the sentence names the remote that did not list it",
        "… (the remote origin does not list it)",
        cell.branch.chipTitle,
      ),
    );
    entries.push(checks(eq(norm(cell.branch.title), norm(a.row.branchWhy)), "the sentence is the API's branchWhy", a.row.branchWhy, cell.branch.title));
  } else if (pin.kind === "unknown-plain") {
    const note = String(a.project.fetchNote || "").trim();
    const cellTitle = norm(`${cell.branch.title} ${cell.branch.chipTitle || ""}`);
    // The claim is about the WORD. A row the panel could not verify must say so (it used to say nothing, and read as
    // one nobody had pushed); what it must never say is `local`, which is the remote's own denial.
    entries.push(
      checks(
        !cell.branch.saysLocal && !cell.branch.chipLocal,
        "an unknown state never reads as local",
        "a chip, but never the LOCAL word",
        `chip=${JSON.stringify(cell.branch.chipText)} local=${cell.branch.chipLocal} saysLocal=${cell.branch.saysLocal}`,
      ),
    );
    entries.push(checks(cell.branch.href === null, "no link is invented when the remote was not asked and no local ref has it", "no <a>", cell.branch.href));
    entries.push(
      checks(
        cell.branch.chipText !== null,
        "a chip is drawn for the unknown state",
        "a .branch-unverified chip",
        `no chip in the branch cell: ${cell.branch.html.slice(0, 160)}`,
      ),
    );
    entries.push(checks(eq(norm(cell.branch.chipVisibleText), "UNVERIFIED"), "the chip reads UNVERIFIED", "UNVERIFIED", cell.branch.chipVisibleText));
    entries.push(
      checks(
        note ? cellTitle.includes(norm(note)) : cell.branch.chipText !== null,
        note ? "the cell quotes the project's fetchNote" : "no fetchNote on this project, so the sentence carries the state alone",
        note || "(none on this project)",
        cellTitle,
      ),
    );
    results.unknownPlainFetchNote = { fetchNote: note, inCell: Boolean(note) && cellTitle.includes(norm(note)) };
  } else if (pin.kind === "unknown-link") {
    const note = a.project.fetchNote || "";
    const cellTitle = norm(`${cell.branch.title} ${cell.branch.chipTitle || ""}`);
    entries.push(checks(!cell.branch.saysLocal && !cell.branch.chipText, "an unknown state never reads as local", "no chip", `chip=${JSON.stringify(cell.branch.chipText)} saysLocal=${cell.branch.saysLocal}`));
    entries.push(checks(eq(cell.branch.href, a.row.branchUrl), "the link is the API's branchUrl", a.row.branchUrl, cell.branch.href));
    entries.push(
      checks(
        /the remote itself was not asked/.test(norm(cell.branch.title)),
        "the tooltip says the remote itself was not asked",
        "… (found in refs/remotes from the last fetch — the remote itself was not asked)",
        cell.branch.title,
      ),
    );
    results.unknownLinkFetchNote = { fetchNote: note, inCell: Boolean(note) && cellTitle.includes(norm(note)) };
  }
  results.pinned.push({ id: pin.id, key: pin.key, project: a.project.name, branch: a.row.branch, remoteBranch: a.row.remoteBranch, api: { branchUrl: a.row.branchUrl, branchLocalOnly: a.row.branchLocalOnly, branchWhy: a.row.branchWhy, fetchNote: a.project.fetchNote }, cell: cell?.branch || null, checks: entries });

  await shoot(pin.key, "branch", `0${results.pinned.length}-${pin.id}-branch.png`);
}

// ---- the PR cell: the number, the state and the page ------------------------------------------
// Every row the API gives a PR to, not only the pinned ones: the cell must agree with `row.pr` and `row.prUrl`
// wherever it is drawn.
const prKeys = [...byKey.keys()];
const prCells = await readCells(prKeys);
const prChecks = [];
for (const [key, v] of prRows) {
  const c = prCells[key];
  const label = `#${v.row.pr.number} ${v.row.pr.state}`;
  if (!c) {
    prChecks.push(checks(false, `${key}: the row is on the board`, "a tr.row", "missing"));
    continue;
  }
  prChecks.push(checks(eq(norm(c.pr.text), label), `${key}: the cell shows the number and state`, label, c.pr.text));
  prChecks.push(checks(eq(c.pr.href, v.row.prUrl), `${key}: the link is the API's prUrl`, v.row.prUrl, c.pr.href));
  const wantCls = v.row.pr.state === "OPEN" ? "pr-open" : "pr-merged";
  prChecks.push(checks(String(c.pr.cls || "").includes(wantCls), `${key}: the chip carries ${wantCls}`, wantCls, c.pr.cls));
}
const noPr = wanted((p, w) => !w.pr);
for (const [key, v] of noPr) {
  const c = prCells[key];
  if (!c) continue;
  // One word, not a sentence: the branch column already answers "the copy was deleted on the remote", so the PR cell
  // says `none` and nothing else (test/pr-cell-none.test.js holds the page to it too).
  prChecks.push(checks(eq(norm(c.pr.text), "none"), `${key}: no PR reads exactly none`, "none", c.pr.text));
}
results.pr = { rowsWithPr: prRows.length, rowsWithout: noPr.length, checks: prChecks };

// Screenshot the PR cell of the pinned rows that have one.
for (const pin of PINNED) {
  const a = api[pin.key];
  if (!a.row.pr) continue;
  await shoot(pin.key, "pr", `0${results.pinned.findIndex((p) => p.key === pin.key) + 1}-${pin.id}-pr.png`);
}
if (prPick && !PINNED.some((p) => p.key === prPick[0])) {
  await shoot(prPick[0], "pr", `09-pr-extra-${prPick[1].project.name.toLowerCase()}.png`);
}

// ---- the whole board: no "local" for anything the API calls remote-backed ----------------------
const allKeys = [...byKey.keys()];
const allCells = await readCells(allKeys);
const missingKeys = allKeys.filter((k) => !allCells[k]);
// Name why a row is not drawn: the age threshold holds rows back until the reader asks for them, and that is a
// board rule, not a cell defect. Anything still missing after the arrows were pressed is reported as a gap.
const ageFlags = await page.evaluate(
  (keys) =>
    keys.map((k) => {
      const r = state.rows.get(k);
      return r ? Boolean(rowAgeHidden(r)) : null;
    }),
  missingKeys,
);
const sweep = {
  rows: allKeys.length,
  missingFromDom: missingKeys.map((key, i) => ({ key, ageHidden: ageFlags[i], branch: byKey.get(key).row.branch })),
  localOnRemoteBacked: [],
  localOnGone: 0,
  goneWithoutChip: [],
  linkMismatch: [],
};
for (const [key, v] of byKey) {
  const c = allCells[key];
  const w = v.row;
  if (!c) {
    sweep.missingFromDom.push(key);
    continue;
  }
  const remoteBacked = w.remoteBranch !== "gone";
  // `unverified` is allowed on a remote-backed row (the panel could not ask); the `local` claim is what must never
  // appear there, because it is the remote's own denial and there is none.
  if (remoteBacked && (c.branch.saysLocal || c.branch.chipLocal)) {
    sweep.localOnRemoteBacked.push({ key, remoteBranch: w.remoteBranch, chip: c.branch.chipText, html: c.branch.html.slice(0, 160) });
  }
  if (w.remoteBranch === "gone") {
    if (c.branch.chipLocal) sweep.localOnGone += 1;
    else sweep.goneWithoutChip.push({ key, api: w.branchWhy });
  }
  if (w.branchUrl && c.branch.href !== w.branchUrl) sweep.linkMismatch.push({ key, api: w.branchUrl, ui: c.branch.href });
}
results.sweep = sweep;

// ---- a hard refresh must not change a cell's state --------------------------------------------
const sig = (c) => JSON.stringify(c);
const stateAfterReload = await getState();
const byKeyAfter = new Map();
for (const p of stateAfterReload.projects || []) for (const w of p.worktrees || []) byKeyAfter.set(rowKey(p.name, w), { project: p, row: w });

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("section.project [data-toggle-project]", { timeout: 30000 });
await expandAll();
await revealStale();
await page.waitForTimeout(800);
const after = await readCells(PINNED.map((p) => p.key));
for (const pin of PINNED) {
  const apiBefore = api[pin.key];
  const apiAfter = byKeyAfter.get(pin.key);
  const apiSame = apiAfter ? eq(sig({ b: apiBefore.row.branch, r: apiBefore.row.remoteBranch, u: apiBefore.row.branchUrl, l: apiBefore.row.branchLocalOnly, p: apiBefore.row.pr }), sig({ b: apiAfter.row.branch, r: apiAfter.row.remoteBranch, u: apiAfter.row.branchUrl, l: apiAfter.row.branchLocalOnly, p: apiAfter.row.pr })) : false;
  results.refresh.push({
    id: pin.id,
    key: pin.key,
    apiUnchanged: apiSame,
    cellUnchanged: sig(before[pin.key]) === sig(after[pin.key]),
    before: before[pin.key],
    after: after[pin.key],
  });
  await shoot(pin.key, "branch", `1${results.refresh.length}-${pin.id}-after-reload-branch.png`);
}

// ---- the fourth state: a row with no branch at all --------------------------------------------
// No live row has an empty branch (every worktree in /api/state carries one), and creating a detached worktree
// to force one would write product state into the reader's board. So the renderer's own input is fed a row with
// no branch, in the page's memory only, and the state it draws is pinned as a fixture.
const FIXTURE_KEY = `${PROJECT}::C:/fixtures/no-branch`;
const fixtureShape = await page.evaluate(
  ({ project, fixtureKey }) => {
    // The page's own model: `state.rows` is a Map keyed `project::path`, and `state.projects` a Map by name.
    const src = [...state.rows.values()].find((r) => r.project === project && String(r.path).includes("playwright-lane-c")) || [...state.rows.values()].find((r) => r.project === project);
    const fx = JSON.parse(JSON.stringify(src));
    fx.name = "fixture-no-branch";
    fx.path = fixtureKey.slice(fixtureKey.indexOf("::") + 2);
    fx.branch = "";
    fx.remoteBranch = "gone";
    fx.branchUrl = null;
    fx.branchLocalOnly = false;
    fx.branchLinkFrom = null;
    fx.branchWhy = "no branch was read for this worktree";
    fx.pr = null;
    fx.prUrl = null;
    fx.prWhy = "";
    state.rows.set(fixtureKey, fx);
    renderProjectRows(project);
    return fx;
  },
  { project: PROJECT, fixtureKey: FIXTURE_KEY },
);
await page.waitForTimeout(400);
const fixture = (await readCells([FIXTURE_KEY]))[FIXTURE_KEY];
const fxChecks = [];
fxChecks.push(checks(Boolean(fixture), "a row with no branch is drawn", "a tr.row", fixture ? "drawn" : "missing"));
if (fixture) {
  fxChecks.push(checks(fixture.branch.href === null, "no link is drawn for a row with no branch", "no <a>", fixture.branch.href));
  fxChecks.push(checks(!fixture.branch.chipText && !fixture.branch.saysLocal, "no local chip for a row with no branch", "no chip", `chip=${JSON.stringify(fixture.branch.chipText)}`));
  fxChecks.push(checks(eq(norm(fixture.branch.text), "—"), "the cell shows the empty-branch mark", "—", fixture.branch.text));
  fxChecks.push(checks(/no branch/.test(norm(fixture.branch.title)), "the tooltip says no branch was read", "no branch was read for this worktree", fixture.branch.title));
}
results.fixture = { key: FIXTURE_KEY, source: "page-memory fixture (no live row has an empty branch)", shape: { branch: "", remoteBranch: "gone", branchWhy: fixtureShape.branchWhy }, cell: fixture?.branch || null, checks: fxChecks };
await shoot(FIXTURE_KEY, "branch", "20-no-branch-fixture-branch.png");

// ---- verdict -----------------------------------------------------------------------------------
const allChecks = [...results.pinned.flatMap((p) => p.checks), ...results.pr.checks, ...fxChecks];
// The sweep is one check per condition over every row, not one per row: a leak here is a count, and a count of zero
// is the result. It is folded into the verdict so a green pinned table cannot hide a board-wide "local" leak.
const sweepFailures = sweep.localOnRemoteBacked.length + sweep.linkMismatch.length + sweep.missingFromDom.length + sweep.goneWithoutChip.length;
results.totals = {
  checks: allChecks.length,
  failed: allChecks.filter((c) => !c.ok).length,
  sweepFailures,
  pinned: results.pinned.length,
  skippedStates: SKIPPED.map((s) => s.id),
  prRows: prRows.length,
  refreshUnchanged: results.refresh.every((r) => r.cellUnchanged && r.apiUnchanged),
  sweepLocalOnRemoteBacked: sweep.localOnRemoteBacked.length,
  missingFromDom: sweep.missingFromDom.length,
};
results.shots = shots;
results.finishedAt = new Date().toISOString();
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));

console.log(`base ${BASE}`);
console.log(`opened ${opened} collapsed project section(s); rows in API ${allKeys.length}, drawn ${allKeys.length - sweep.missingFromDom.length}`);
// What this board could not show. A skipped state is not a pass: it is the harness saying the claim was not judged.
for (const s of SKIPPED) console.log(`\n[skipped] ${s.id}: ${s.why} — that claim was NOT judged by this run`);
for (const p of results.pinned) {
  console.log(`\n[${p.id}] ${p.project} · ${p.branch} · remoteBranch=${p.remoteBranch}`);
  console.log(`  cell: ${JSON.stringify(p.cell && { text: p.cell.text, href: p.cell.href, chip: p.cell.chipVisibleText, title: (p.cell.chipTitle || p.cell.title || "").slice(0, 130) })}`);
  for (const c of p.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.what}${c.ok ? "" : `\n       expected: ${c.expected}\n       actual:   ${c.actual}`}`);
}
console.log(`\n[pr] rows with a PR: ${prRows.length}, without: ${noPr.length}; failed checks: ${prChecks.filter((c) => !c.ok).length}`);
for (const c of prChecks.filter((c) => !c.ok).slice(0, 12)) console.log(`  FAIL ${c.what}\n       expected: ${c.expected}\n       actual:   ${c.actual}`);
console.log(`\n[fixture no-branch]`);
for (const c of fxChecks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.what}${c.ok ? "" : `\n       expected: ${c.expected}\n       actual:   ${c.actual}`}`);
console.log(`\n[sweep] rows ${sweep.rows} · local on remote-backed ${sweep.localOnRemoteBacked.length} · gone with chip ${sweep.localOnGone}/${sweep.localOnGone + sweep.goneWithoutChip.length} · link mismatches ${sweep.linkMismatch.length} · missing from DOM ${sweep.missingFromDom.length}`);
for (const x of sweep.localOnRemoteBacked.slice(0, 10)) console.log(`  FAIL local on ${x.remoteBranch}: ${x.key}`);
console.log(`\n[hard refresh]`);
for (const r of results.refresh) console.log(`  ${r.cellUnchanged ? "PASS" : "FAIL"} ${r.id}: cell unchanged=${r.cellUnchanged} api unchanged=${r.apiUnchanged}`);
console.log(`\nshots in ${SHOT_DIR}`);
for (const s of shots) console.log("  " + s);
console.log(`\nTOTAL ${results.totals.checks} pinned/PR/fixture checks, ${results.totals.failed} failed · sweep ${sweepFailures} failure(s) · refresh ${results.totals.refreshUnchanged ? "unchanged" : "CHANGED"}`);
await browser.close();
process.exit(results.totals.failed === 0 && sweepFailures === 0 && results.totals.refreshUnchanged ? 0 : 1);
