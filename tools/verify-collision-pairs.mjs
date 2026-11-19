// tools/verify-collision-pairs.mjs - the collision surface as ONE CARD PER PAIR, drawn on BOTH rows, driven in a real
// browser against a real panel. HARNESS: LIVE GATE - `npm run verify:collision-pairs` is how the repo runs it by name.
//
//   node tools/verify-collision-pairs.mjs                  # boot a throwaway panel and drive it
//   node tools/verify-collision-pairs.mjs --root <tree>     # serve a `git archive` of another build (RED PROOF)
//   node tools/verify-collision-pairs.mjs --shots <dir>     # write the screenshots there (default .shots/)
//
// WHAT IT PROVES, at 1440x900 against a fixture that is REAL git and REAL branches:
//
//   1. ONE PAIR, ONE RECORD, DRAWN ON BOTH ROWS. Two trees dirty on the same file are ONE pair. Each row draws it
//      once - not a card per side - and each card names BOTH trees (this row and the counterpart), so neither side
//      has to reconcile the other by hand.
//   2. A REAL PAIR FILED AND STOOD DOWN. A second pair on a different file is seeded through the panel's own sweep
//      with two filed queue rows; one of them is then closed, and the pair stands down on its own. Both rows read
//      the same reason ("its notice #51 was done"), which is what the side that did not yield otherwise had to ask for.
//   3. A SIBLING PAIR. Two branches cut from one parent that each COMMITTED a change to the same file are caught as a
//      pair - compared against each other, not filed twice against the parent.
//   4. THE MERGE-TARGET-ONLY CASE FILES NOTHING. The primary checkout on main is dirty; a worker's tree cut from main
//      touches a different file, and the parent book records main as its parent - the exact shape that filed four
//      rows of noise in one night. The sweep's pair count never includes it, no record exists for it, and the primary
//      row wears no marker.
//
// On top of the four: the ruled pair re-reads as "already ruled" on both rows after a fresh detection, the Human badge
// counts the pair ONCE (a decision, not a marker), H parks on it, and the Collisions switch still turns it off.
//
// WHAT IT DOES NOT PROVE: the queue rows themselves. `fileQueue` is the panel's own route, and this sandbox has the
// assistant disabled, so the two filed rows are seeded through `sweepCollisions` with a fake queue (the same seam
// test/collisions.test.js drives); the card, the stand-down and the reason are then read off the real page.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, withBrowser, openPage } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";
import { CollisionBook, COLLISION_PASS_MS } from "../lib/collisions.js";
import { sweepCollisions } from "../lib/collision-flow.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const SHOT_DIR = opt("--shots", process.env.PANEL_SHOT_DIR || path.join(HERE, "..", ".shots"));
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));

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
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), got === want ? String(got) : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (name) => console.log(`\n-- ${name}`);

const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log("BROWSER-HALF-NOT-RUN  no Playwright install found - set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright");
  process.exit(2);
}

// ---- the fixture: one project, a primary checkout on main, and six trees -------------------------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-collision-pairs-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "pair-proj");
const git = (args, cwd = repo) =>
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "gate",
      GIT_AUTHOR_EMAIL: "gate@local",
      GIT_COMMITTER_NAME: "gate",
      GIT_COMMITTER_EMAIL: "gate@local",
    },
  });
mkdirSync(repo, { recursive: true });
git(["init", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# collision pairs fixture\n");
mkdirSync(path.join(repo, "lib"), { recursive: true });
mkdirSync(path.join(repo, "src"), { recursive: true });
writeFileSync(path.join(repo, "lib", "shared.js"), "export const shared = 1;\n");
writeFileSync(path.join(repo, "lib", "other.js"), "export const other = 1;\n");
writeFileSync(path.join(repo, "src", "sibling.js"), "export const sibling = 1;\n");
git(["add", "-A"]);
git(["commit", "-m", "fixture"]);

// ONE and TWO: the same file dirty in both trees - the pair the card is drawn for.
const ONE = path.join(repo, ".worktrees", "pair-a").replace(/\\/g, "/");
const TWO = path.join(repo, ".worktrees", "pair-b").replace(/\\/g, "/");
// STOOD1 and STOOD2: a second pair, filed and then stood down.
const STOOD1 = path.join(repo, ".worktrees", "stood-c").replace(/\\/g, "/");
const STOOD2 = path.join(repo, ".worktrees", "stood-d").replace(/\\/g, "/");
// SIB1 and SIB2: two branches cut from main that each COMMIT the same file - siblings.
const SIB1 = path.join(repo, ".worktrees", "sib-one").replace(/\\/g, "/");
const SIB2 = path.join(repo, ".worktrees", "sib-two").replace(/\\/g, "/");
const branchOf = { [ONE]: "wtgui/pair-a", [TWO]: "wtgui/pair-b", [STOOD1]: "wtgui/stood-c", [STOOD2]: "wtgui/stood-d", [SIB1]: "wtgui/sib-one", [SIB2]: "wtgui/sib-two" };
const nameOf = { [ONE]: "pair-a", [TWO]: "pair-b", [STOOD1]: "stood-c", [STOOD2]: "stood-d", [SIB1]: "sib-one", [SIB2]: "sib-two" };
git(["worktree", "add", "-b", branchOf[ONE], ONE]);
git(["worktree", "add", "-b", branchOf[TWO], TWO]);
git(["worktree", "add", "-b", branchOf[STOOD1], STOOD1]);
git(["worktree", "add", "-b", branchOf[STOOD2], STOOD2]);
git(["worktree", "add", "-b", branchOf[SIB1], SIB1]);
git(["worktree", "add", "-b", branchOf[SIB2], SIB2]);
// The dirty pairs: same file, one per pair, uncommitted.
writeFileSync(path.join(ONE, "lib", "shared.js"), "export const shared = 'one';\n");
writeFileSync(path.join(TWO, "lib", "shared.js"), "export const shared = 'two';\n");
writeFileSync(path.join(STOOD1, "lib", "other.js"), "export const other = 'c';\n");
writeFileSync(path.join(STOOD2, "lib", "other.js"), "export const other = 'd';\n");
// The sibling pair: two branches from ONE parent, each with its OWN commit on the same file.
writeFileSync(path.join(SIB1, "src", "sibling.js"), "export const sibling = 'one';\n");
git(["add", "-A"], SIB1);
git(["commit", "-m", "sib one changes the shared module"], SIB1);
writeFileSync(path.join(SIB2, "src", "sibling.js"), "export const sibling = 'two';\n");
git(["add", "-A"], SIB2);
git(["commit", "-m", "sib two changes the same module"], SIB2);
// The primary checkout itself: dirty on a file NO tree touches. That makes it live, and it makes the merge-target
// case real - main is the parent of every worker tree here.
writeFileSync(path.join(repo, "README.md"), "# collision pairs fixture - the reader's own notes\n");

// The parent book, as the panel's CUT would have written it: every worker tree was cut from main. This is not a
// shortcut around the scan - it is the one store the scan reads for a parent, and it is exactly what makes the
// merge-target relation true for the primary checkout.
const PARENTS_FILE = path.join(dir, "logs", "parents.json");
const parents = {
  version: 1,
  records: [ONE, TWO, STOOD1, STOOD2, SIB1, SIB2].map((p) => ({
    project: "pair-proj",
    branch: branchOf[p],
    path: p,
    parent: "main",
    parentSha: null,
    parentRef: "main",
    parentSource: "cut",
    why: "",
    at: new Date().toISOString(),
  })),
};
mkdirSync(path.dirname(PARENTS_FILE), { recursive: true });
writeFileSync(PARENTS_FILE, JSON.stringify(parents, null, 2));

// ---- the stood-down pair: filed through the real sweep, then one side's notice closed -------------------------------
const BOOK_FILE = path.join(dir, "logs", "collisions.json");
const book = new CollisionBook({ file: BOOK_FILE, log: (m) => console.log(`      book: ${m}`) });
const seedRows = (paths) => paths.map((p) => ({ project: "pair-proj", path: p, branch: branchOf[p], name: nameOf[p], parent: "main", live: true, dirtyFiles: [{ code: "M", path: p === STOOD1 || p === STOOD2 ? "lib/other.js" : "lib/shared.js" }] }));
const seedTasks = { "assistant-1": [], "assistant-2": [] };
const seedDeps = {
  ownerOf: (side) => (side.path === STOOD1 ? "assistant-1" : "assistant-2"),
  nameOf: (id) => id,
  taskIdFor: (row) => (row.path === STOOD1 ? 51 : 52),
  tasksFor: (id) => seedTasks[id] || [],
  fileQueue: (payload) => {
    const taskId = payload.assistantId === "assistant-1" ? 51 : 52;
    seedTasks[payload.assistantId].push({ id: taskId, state: "queued", files: ["lib/other.js"] });
    return { taskId };
  },
};
const seedAt = Date.now() - 30_000;
const filedSeed = sweepCollisions({ rows: seedRows([STOOD1, STOOD2]), book, now: seedAt, ...seedDeps });
ok("the stood-down pair was filed into both queues by its own sweep", filedSeed.filed.length === 2, JSON.stringify(filedSeed.filed));
seedTasks["assistant-1"][0].state = "done";
const stoodSeed = sweepCollisions({ rows: seedRows([STOOD1, STOOD2]), book, now: seedAt + 3000, ...seedDeps });
ok("one side closing its notice stood the pair down, with the reason", stoodSeed.stoodDown.length === 1 && stoodSeed.stoodDown[0].taskId === 51 && stoodSeed.stoodDown[0].state === "done", JSON.stringify(stoodSeed.stoodDown));
const seedRec = [...book.all()].find((r) => r.a?.path === STOOD1 || r.b?.path === STOOD1);
ok("the seed record is one pair naming both trees and the shared file", Boolean(seedRec) && seedRec.a?.path === STOOD1 && seedRec.b?.path === STOOD2 && seedRec.files?.join() === "lib/other.js", seedRec ? `${seedRec.a?.name}/${seedRec.b?.name}/${seedRec.files}` : "no record");
ok("…and it is still with the assistants, not the reader", seedRec && !seedRec.readerAt && !seedRec.ruling);
// The book is the panel's, so the seed goes through its own writer: a record that never reached the file is a record
// the panel cannot boot from.
const wrote = book.save();
ok("the seed record reached the book file the panel boots from", wrote.ok === true, String(wrote.error || "written"));

const panel = await startPanel({
  root: TREE,
  dir,
  keep: true,
  config: { collisionsFile: BOOK_FILE, parentsFile: PARENTS_FILE, assistant: { enabled: false } },
});
console.log(`      panel   ${panel.base}  (throwaway: ${panel.dir})`);
const shots = path.resolve(SHOT_DIR);
mkdirSync(shots, { recursive: true });

const result = await (async () => {
  try {
    return await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        const rowsLoaded = () =>
          page.waitForFunction(
            () => {
              try {
                return state.rows && state.rows.size >= 7;
              } catch {
                return false;
              }
            },
            null,
            { timeout: 60_000 },
          );
        const swept = () =>
          page.evaluate(async () => {
            const r = await fetch("/api/collisions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ op: "sweep" }),
            });
            return r.json();
          });
        // The sweep reads the rows the SCANNER wrote, so the first one after boot can run before the boot scan has
        // finished and see fewer pairs. The proof asks for a sweep until the detector has all THREE, which is what the
        // panel's own 10 s clock does, only bounded.
        const sweepUntilPairs = async (want = 3) => {
          for (let i = 0; i < 30; i += 1) {
            const out = await swept();
            if (out?.report?.pairs === want) return out;
            await page.waitForTimeout(1000);
          }
          return swept();
        };
        const painted = () =>
          page.waitForFunction(
            () => {
              const btn = document.getElementById("btn-human");
              return Boolean(btn && btn.title && !/^Human — every open permission/.test(btn.title));
            },
            null,
            { timeout: 20_000 },
          );
        const withCollisions = () =>
          page.waitForFunction(
            () => {
              try {
                return [...state.rows.values()].filter((r) => (r.collisions || []).length > 0).length >= 6;
              } catch {
                return false;
              }
            },
            null,
            { timeout: 60_000 },
          );
        const view = () =>
          page.evaluate(() => {
            const rows = [...state.rows.values()].map((r) => ({
              name: r.name,
              path: r.path,
              branch: r.branch,
              live: r.live === true,
              collisions: (r.collisions || []).map((c) => ({
                key: c.key,
                state: c.state,
                role: c.role,
                other: c.other?.name || null,
                a: c.a ? { name: c.a.name, path: c.a.path, branch: c.a.branch, taskId: c.a.taskId ?? null } : null,
                b: c.b ? { name: c.b.name, path: c.b.path, branch: c.b.branch, taskId: c.b.taskId ?? null } : null,
                files: c.files,
                relations: (c.relations || []).map((x) => x.kind),
                source: c.source,
                stoodDown: c.stoodDown || [],
                ruling: c.ruling ? { name: c.ruling.name, pick: c.ruling.pick } : null,
                canAsk: c.canAsk,
              })),
            }));
            const btn = document.getElementById("btn-human");
            const badge = document.getElementById("human-badge");
            const label = document.getElementById("human-label");
            let list = [];
            try {
              list = humanQuestions().map((q) => ({ kind: q.kind, key: q.key }));
            } catch {
              list = [];
            }
            return {
              rows,
              badge: (badge?.textContent || "").trim(),
              badgeHidden: badge ? badge.hidden : null,
              label: (label?.textContent || "").trim(),
              title: btn?.title || "",
              aria: btn?.getAttribute("aria-label") || "",
              list,
              humanKey: state.human.key,
              blocks: [...document.querySelectorAll("[data-collision-block]")].map((el) => ({
                rowKey: el.getAttribute("data-collision-block"),
                key: el.getAttribute("data-collision-pair"),
                state: (el.querySelector(".collision-state")?.textContent || "").trim(),
                sides: [...el.querySelectorAll(".collision-side")].map((s) => ({
                  role: s.getAttribute("data-collision-side"),
                  mine: s.classList.contains("is-mine"),
                  name: (s.querySelector(".collision-side-name")?.textContent || "").trim(),
                  task: (s.querySelector(".collision-task")?.textContent || "").trim(),
                })),
                other: (el.querySelector(".collision-other b")?.textContent || "").trim(),
                say: (el.querySelector(".collision-say")?.textContent || "").trim(),
                chips: [...el.querySelectorAll(".collision-chip")].map((c) => c.textContent.trim()),
                stood: (el.querySelector(".collision-stood")?.textContent || "").trim(),
              })),
              marks: [...document.querySelectorAll("tr.row")].map((tr) => ({
                row: tr.getAttribute("data-key"),
                mark: (tr.querySelector(".collision-mark")?.getAttribute("title") || "").trim(),
              })),
            };
          });
        const openAll = () =>
          page.evaluate(() => {
            for (const r of state.rows.values()) hotOpenPath(r);
            renderAll();
          });

        await openPage(page, panel.base, { selector: "header.topbar #btn-human" });
        await rowsLoaded();

        // ---- 1. one pair, one record, drawn on both rows ---------------------------------------------------
        section("one pair, one record, drawn on both rows");
        const first = await sweepUntilPairs(3);
        ok("the sweep found exactly three pairs", first?.report?.pairs === 3, JSON.stringify(first?.report ? { pairs: first.report.pairs } : first));
        await page.reload({ waitUntil: "domcontentloaded" });
        await rowsLoaded();
        await withCollisions();
        await painted();
        let v = await view();
        const rowA = v.rows.find((r) => r.name === "pair-a");
        const rowB = v.rows.find((r) => r.name === "pair-b");
        ok("both rows of the pair are live, which is what makes them a pair", rowA?.live === true && rowB?.live === true);
        eq("both rows carry ONE record of the same pair", [rowA?.collisions.length, rowB?.collisions.length, rowA?.collisions[0]?.key === rowB?.collisions[0]?.key], [1, 1, true]);
        const pairKey = rowA?.collisions[0]?.key;
        eq("the record holds BOTH sides, trees and branches", [rowA?.collisions[0]?.a?.name, rowA?.collisions[0]?.b?.name, rowA?.collisions[0]?.a?.branch, rowA?.collisions[0]?.b?.branch], ["pair-a", "pair-b", "wtgui/pair-a", "wtgui/pair-b"]);
        eq("the evidence is the one shared file", rowA?.collisions[0]?.files, ["lib/shared.js"]);
        eq("each row names the OTHER tree", [rowA?.collisions[0]?.other, rowB?.collisions[0]?.other], ["pair-b", "pair-a"]);

        await openAll();
        await page.waitForTimeout(300);
        v = await view();
        const blocksA = v.blocks.filter((b) => b.key === pairKey && b.rowKey.endsWith("pair-a"));
        const blocksB = v.blocks.filter((b) => b.key === pairKey && b.rowKey.endsWith("pair-b"));
        eq("the pair is drawn ONCE on each row, not once per side", [blocksA.length, blocksB.length], [1, 1]);
        // Both cards name the same two trees, with this row's own side marked: the counterpart is named on BOTH.
        for (const [label, b] of [["pair-a", blocksA[0]], ["pair-b", blocksB[0]]]) {
          const names = b.sides.map((s) => s.name).sort();
          eq(`the card on ${label} names both trees`, names, ["pair-a", "pair-b"]);
          eq(`…with its own side marked on ${label}`, b.sides.filter((s) => s.mine).map((s) => s.name), [label]);
          eq(`…and the counterpart named in the heading on ${label}`, b.other, label === "pair-a" ? "pair-b" : "pair-a");
          ok(`…with the shared file as the evidence on ${label}`, b.chips.includes("lib/shared.js"), JSON.stringify(b.chips));
        }
        eq("six rows wear a marker, one per side of three pairs", v.marks.filter((m) => m.mark).length, 6);
        await page.screenshot({ path: path.join(shots, "collision-pairs-both-rows-1440x900.png"), fullPage: true });
        console.log(`SHOT  ${path.join(shots, "collision-pairs-both-rows-1440x900.png")}`);

        // ---- 2. the filed-and-stood-down pair, its reason readable on both rows ------------------------------
        section("a real pair, filed and stood down");
        const stoodC = v.rows.find((r) => r.name === "stood-c");
        const stoodD = v.rows.find((r) => r.name === "stood-d");
        eq("both rows carry the same stood-down pair", [stoodC?.collisions[0]?.key === stoodD?.collisions[0]?.key, stoodC?.collisions[0]?.files], [true, ["lib/other.js"]]);
        eq("it is still with the assistants", [stoodC?.collisions[0]?.state, stoodD?.collisions[0]?.state], ["assistants", "assistants"]);
        const stoodBlocks = v.blocks.filter((b) => b.key === stoodC?.collisions[0]?.key);
        eq("the card is drawn once on each of its two rows", stoodBlocks.length, 2);
        ok("both cards say which side stood down and why", stoodBlocks.every((b) => /stood-c stood down: its notice #51 was done/.test(b.stood)), JSON.stringify(stoodBlocks.map((b) => b.stood)));
        eq("…and each names the counterpart", stoodBlocks.map((b) => b.other).sort(), ["stood-c", "stood-d"]);
        await page.screenshot({ path: path.join(shots, "collision-pairs-stood-down-1440x900.png"), fullPage: true });
        console.log(`SHOT  ${path.join(shots, "collision-pairs-stood-down-1440x900.png")}`);

        // ---- 3. two branches from one parent, caught against each other -------------------------------------
        section("a sibling pair");
        const sibOne = v.rows.find((r) => r.name === "sib-one");
        const sibTwo = v.rows.find((r) => r.name === "sib-two");
        eq("the siblings are ONE pair, keyed the same on both rows", [sibOne?.collisions.length, sibTwo?.collisions.length, sibOne?.collisions[0]?.key === sibTwo?.collisions[0]?.key], [1, 1, true]);
        eq("…classified as siblings under main, not as two collisions with it", sibOne?.collisions[0]?.relations, ["sibling"]);
        eq("…on the committed file both branches change", sibOne?.collisions[0]?.files, ["src/sibling.js"]);
        eq("…each naming the other", [sibOne?.collisions[0]?.other, sibTwo?.collisions[0]?.other], ["sib-two", "sib-one"]);
        ok("…and the primary checkout is NOT one of their pair", ![sibOne?.collisions[0]?.a?.name, sibOne?.collisions[0]?.b?.name].includes("pair-proj"));

        // ---- 4. the merge-target-only case files nothing ----------------------------------------------------
        section("the merge-target-only case");
        const primary = v.rows.find((r) => r.name === "pair-proj");
        ok("the primary checkout is live and dirty on a file no tree touches", primary?.live === true);
        eq("the book holds three records, one per evidence pair", (await page.evaluate(async () => (await (await fetch("/api/collisions")).json()).total)), 3);
        eq("…and it carries NO collision of its own", primary?.collisions?.length ?? -1, 0);
        eq("…and wears no marker", v.marks.find((m) => m.row && m.row.endsWith("pair-proj"))?.mark ?? "", "");
        const all = await page.evaluate(async () => (await (await fetch("/api/collisions")).json()).records || []);
        eq("no record on the book is a merge-target relation alone", all.filter((r) => (r.relations || []).length && r.relations.every((x) => x.kind === "merge-target")).length, 0);
        eq("three records for three evidence pairs", all.length, 3);
        await page.screenshot({ path: path.join(shots, "collision-pairs-merge-target-only-1440x900.png"), fullPage: true });
        console.log(`SHOT  ${path.join(shots, "collision-pairs-merge-target-only-1440x900.png")}`);

        // ---- 5. the ruling, from the row the reader is looking at -------------------------------------------
        section("the reader rules on the pair");
        const mineRole = rowA?.collisions[0]?.role === "b" ? "b" : "a";
        const pressed = await page.evaluate(
          ({ k, pick }) => {
            const block = [...document.querySelectorAll("[data-collision-block]")].find(
              (x) => x.getAttribute("data-collision-pair") === k && (x.getAttribute("data-collision-block") || "").endsWith("pair-a"),
            );
            const el = block?.querySelector(`[data-collision-rule="${CSS.escape(k)}"][data-collision-pick="${pick}"]`);
            if (!el) return false;
            el.click();
            return true;
          },
          { k: pairKey, pick: mineRole },
        );
        ok("the ruling press is on pair-a's own card", pressed === true, String(pressed));
        await page.waitForFunction(
          (k) => [...state.rows.values()].some((r) => (r.collisions || []).some((c) => c.key === k && c.state === "ruled")),
          pairKey,
          { timeout: 20_000 },
        );
        v = await view();
        const ruledA = v.rows.find((r) => r.name === "pair-a")?.collisions[0];
        const ruledB = v.rows.find((r) => r.name === "pair-b")?.collisions[0];
        eq("both rows read it as ruled", [ruledA?.state, ruledB?.state], ["ruled", "ruled"]);
        eq("the ruling names the tree the reader pressed, on both rows", [ruledA?.ruling?.name, ruledB?.ruling?.name], ["pair-a", "pair-a"]);
        ok("both cards say already ruled", v.blocks.filter((b) => b.key === pairKey).every((b) => /already ruled: pair-a( \(#\d+\))? goes first/.test(b.state)), JSON.stringify(v.blocks.filter((b) => b.key === pairKey).map((b) => b.state)));
        eq("the pair's sides carry a queue task id when the panel filed one", [rowA?.collisions[0]?.a?.taskId, rowA?.collisions[0]?.b?.taskId].map((x) => (x === null || typeof x === "number" ? "ok" : "bad")), ["ok", "ok"]);
        await page.screenshot({ path: path.join(shots, "collision-pairs-ruled-1440x900.png"), fullPage: true });
        console.log(`SHOT  ${path.join(shots, "collision-pairs-ruled-1440x900.png")}`);

        // ---- 6. the badge counts decisions, and a re-detection does not ask again ---------------------------
        section("the badge, and a re-detection");
        await page.waitForTimeout(COLLISION_PASS_MS + 600);
        const again = await swept();
        ok("the sweep still sees three pairs", again?.report?.pairs === 3, JSON.stringify(again?.report ? { pairs: again.report.pairs } : again));
        const rec = (await page.evaluate(async () => (await (await fetch("/api/collisions")).json()).records || [])).find((r) => r.key === pairKey);
        ok("the ruled pair survived the re-detection, still ruled", rec?.state === "ruled" && rec?.ruling?.name === "pair-a", JSON.stringify(rec ? { state: rec.state, name: rec.ruling?.name } : null));
        eq("…and there is still ONE record for it", (await page.evaluate(async () => (await (await fetch("/api/collisions")).json()).records || [])).filter((r) => r.key === pairKey).length, 1);
        await page.reload({ waitUntil: "domcontentloaded" });
        await rowsLoaded();
        await withCollisions();
        await painted();
        v = await view();
        ok("after a reload both rows still render it as already ruled", [v.rows.find((r) => r.name === "pair-a")?.collisions[0]?.state, v.rows.find((r) => r.name === "pair-b")?.collisions[0]?.state].join() === "ruled,ruled");
        // The badge counts the SIBLING pair once (it came to the reader on the second pass); the ruled pair and the
        // stood-down pair are not questions any more.
        eq("the badge counts one decision, not six markers", [v.badge, v.badgeHidden], ["1", false]);
        ok("…and the title names the collision kind once", /1 collision/.test(v.title), v.title.slice(0, 120));
        eq("…and the rotation holds one collision item", v.list.filter((q) => q.kind === "collision").length, 1);
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.keyboard.press("h");
        await page.waitForTimeout(300);
        const stepped = await view();
        ok("H steps into the collision", /^collision:/.test(stepped.humanKey || ""), String(stepped.humanKey));

        // ---- 7. the Collisions switch still turns the kind off ----------------------------------------------
        section("the Human kind and its switch");
        const openSettings = async () => {
          const open = await page.evaluate(() => !document.getElementById("settings-panel-human")?.hidden);
          if (!open) await page.click("#btn-settings");
          await page.click("#settings-tab-human");
        };
        await openSettings();
        await page.waitForSelector("#human-kind-collisions", { state: "visible", timeout: 10_000 });
        await page.click("#human-kind-collisions");
        await page.waitForTimeout(300);
        const off = await view();
        eq("switching Collisions off empties the rotation of collisions", off.list.filter((q) => q.kind === "collision").length, 0);
        ok("…and the badge goes quiet", off.badgeHidden === true, JSON.stringify([off.badge, off.badgeHidden]));
        await page.click("#human-kind-collisions");
        await page.waitForTimeout(300);
        const on = await view();
        eq("switching it back on restores the count", [on.badge, on.list.filter((q) => q.kind === "collision").length], ["1", 1]);

        ok("no page error", pageErrors.length === 0, pageErrors.join(" | "));
        ok("no console error", consoleErrors.length === 0, consoleErrors.join(" | "));
        return failures;
      },
      { viewport: { width: 1440, height: 900 } },
    );
  } catch (err) {
    console.log(`FAIL  the harness itself: ${err && err.stack ? err.stack : err}`);
    failures += 1;
    return failures;
  }
})();

console.log(`\n${failures ? "FAILED" : "OK"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
