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
//   5. EACH SIDE NAMES THE TASK IT IS WORKING. Two live trees against TWO REAL QUEUE FILES on disk (state/assistants/
//      <id>/queue.json, one row per tree, two assistants): both cards name each side's task number, its own title, the
//      assistant whose queue holds it and its state. The resolution is the row's OWN `worktree` field, so the proof
//      seeds worktrees, not branches - and a task row whose branch text would have matched somebody else's tree never
//      answers. A side no queue row owns reads "no task row on this tree"; a side whose own task is done reads as
//      already stood down and its pair is not counted for the reader.
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
import { writeAssistantsFile } from "../lib/assistants.js";
import { writeQueueFor } from "../lib/assistant/queue.js";

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
writeFileSync(path.join(repo, "lib", "loose.js"), "export const loose = 1;\n");
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
// LOOSE1 and LOOSE2: a shared-file pair where only ONE side is named by a queue row - the honest "no task row" case.
const LOOSE1 = path.join(repo, ".worktrees", "loose-a").replace(/\\/g, "/");
const LOOSE2 = path.join(repo, ".worktrees", "loose-b").replace(/\\/g, "/");
const branchOf = {
  [ONE]: "wtgui/pair-a",
  [TWO]: "wtgui/pair-b",
  [STOOD1]: "wtgui/stood-c",
  [STOOD2]: "wtgui/stood-d",
  [SIB1]: "wtgui/sib-one",
  [SIB2]: "wtgui/sib-two",
  [LOOSE1]: "wtgui/loose-a",
  [LOOSE2]: "wtgui/loose-b",
};
const nameOf = {
  [ONE]: "pair-a",
  [TWO]: "pair-b",
  [STOOD1]: "stood-c",
  [STOOD2]: "stood-d",
  [SIB1]: "sib-one",
  [SIB2]: "sib-two",
  [LOOSE1]: "loose-a",
  [LOOSE2]: "loose-b",
};
git(["worktree", "add", "-b", branchOf[ONE], ONE]);
git(["worktree", "add", "-b", branchOf[TWO], TWO]);
git(["worktree", "add", "-b", branchOf[STOOD1], STOOD1]);
git(["worktree", "add", "-b", branchOf[STOOD2], STOOD2]);
git(["worktree", "add", "-b", branchOf[SIB1], SIB1]);
git(["worktree", "add", "-b", branchOf[SIB2], SIB2]);
git(["worktree", "add", "-b", branchOf[LOOSE1], LOOSE1]);
git(["worktree", "add", "-b", branchOf[LOOSE2], LOOSE2]);
// The dirty pairs: same file, one per pair, uncommitted.
writeFileSync(path.join(ONE, "lib", "shared.js"), "export const shared = 'one';\n");
writeFileSync(path.join(TWO, "lib", "shared.js"), "export const shared = 'two';\n");
writeFileSync(path.join(STOOD1, "lib", "other.js"), "export const other = 'c';\n");
writeFileSync(path.join(STOOD2, "lib", "other.js"), "export const other = 'd';\n");
writeFileSync(path.join(LOOSE1, "lib", "loose.js"), "export const loose = 'one';\n");
writeFileSync(path.join(LOOSE2, "lib", "loose.js"), "export const loose = 'two';\n");
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
  records: [ONE, TWO, STOOD1, STOOD2, SIB1, SIB2, LOOSE1, LOOSE2].map((p) => ({
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

// ---- the tasks each side is working: TWO REAL ASSISTANT QUEUES on disk --------------------------------------------
// The panel resolves a side's task out of every assistant's queue, matched on the row's OWN `worktree` field - the
// field a spawn writes - so the fixture writes those files exactly as the queue store writes them, and the trees the
// rows name are the trees this proof made. Two assistants, because the card has to say WHOSE queue a row sits in.
//
//   #7  running  pair-a   Assistant #1   the card's own real pair, this side
//   #8  queued   pair-b   Assistant #2   ...and the other side, a different assistant and a different state
//   #61 done     sib-one  Assistant #1   a side whose work is finished: the pair is already stood down
//   #62 queued   sib-two  Assistant #2   the sibling pair's live side
//   #71 queued   loose-b  Assistant #2   the no-row pair's only named side (loose-a has none)
const STATE_DIR = path.join(dir, "logs");
const NOW_ISO = new Date().toISOString();
writeAssistantsFile(path.join(STATE_DIR, "assistants.json"), [
  { id: "assistant-1", name: "Assistant #1", threadId: "panel-assistant", rules: [], createdAt: NOW_ISO },
  { id: "assistant-2", name: "Assistant #2", threadId: "panel-assistant-2", rules: [], createdAt: NOW_ISO },
]);
writeQueueFor(STATE_DIR, "assistant-1", [
  // A row that is on the SAME work as the pair, and one on another tree entirely: only the tree's own worktree field
  // may answer, because a branch is not the association.
  { id: 7, title: "Land the collision card on both rows", detail: "the task this side is really on", state: "running", worktree: ONE, files: ["lib/shared.js"], thread: "panel-assistant", createdAt: NOW_ISO },
  { id: 61, title: "Compare the two siblings", state: "done", worktree: SIB1, files: [], thread: "panel-assistant", doneAt: NOW_ISO, createdAt: NOW_ISO },
  { id: 99, title: "A row on a different tree that carries pair-a's branch name", state: "queued", worktree: path.join(repo, ".worktrees", "elsewhere").replace(/\\/g, "/"), files: [], createdAt: NOW_ISO },
]);
writeQueueFor(STATE_DIR, "assistant-2", [
  { id: 8, title: "Show each side's task beside its tree", detail: "the other side of the same pair", state: "queued", worktree: TWO, files: [], thread: "panel-assistant-2", createdAt: NOW_ISO },
  { id: 62, title: "Rewrite the shared module", state: "queued", worktree: SIB2, files: [], thread: "panel-assistant-2", createdAt: NOW_ISO },
  { id: 71, title: "Rewrite the loose end", state: "queued", worktree: LOOSE2, files: ["lib/loose.js"], thread: "panel-assistant-2", createdAt: NOW_ISO },
]);

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
        const rowsLoaded = async (want = 9) => {
          for (let i = 0; i < 120; i += 1) {
            const seen = await page.evaluate(() => {
              try {
                return [...state.rows.values()].map((r) => r.name || r.path);
              } catch {
                return [];
              }
            });
            if (seen.length >= want) return seen;
            await page.waitForTimeout(500);
          }
          const seen = await page.evaluate(() => {
            try {
              return [...state.rows.values()].map((r) => r.name || r.path);
            } catch {
              return [];
            }
          });
          throw new Error(`the board never showed ${want} rows, it showed ${seen.length}: ${seen.join(", ")}`);
        };
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
        // finished and see fewer pairs. The proof asks for a sweep until the detector has all FOUR, which is what the
        // panel's own 10 s clock does, only bounded.
        const sweepUntilPairs = async (want = 4) => {
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
        // ---- THE CARD IS A POPUP ----------------------------------------------------------------------------
        // The pair card left the row's detail and lives behind the row's collision diamond, so a proof has to OPEN
        // it. One card is open at a time, which is what makes "drawn once on each row" checkable at all: open
        // pair-a's diamond and there is exactly one block, and it names pair-a as its own row.
        const expandAll = () =>
          page.evaluate(() => {
            for (const g of document.querySelectorAll("section.root-group.collapsed")) document.querySelector(`[data-toggle-root="${g.dataset.root}"]`)?.click();
            for (const p of document.querySelectorAll("section.project.collapsed")) document.querySelector(`[data-toggle-project="${p.dataset.project}"]`)?.click();
          });
        const clickDiamond = (name) =>
          page.evaluate((n) => {
            const tr = [...document.querySelectorAll("tr.row")].find((t) => (t.getAttribute("data-key") || "").endsWith(n));
            const d = tr?.querySelector("[data-collision-diamond]");
            if (!d) return false;
            d.click();
            return true;
          }, name);
        const openCard = async (name) => {
          let opened = await clickDiamond(name);
          if (!opened) {
            // A group or project starts collapsed in a fresh context, and a collapsed project paints no row at all.
            await expandAll();
            await page.waitForTimeout(250);
            opened = await clickDiamond(name);
          }
          if (!opened) throw new Error(`no collision diamond on the row for ${name}`);
          await page.waitForSelector(".rowchip-pop .collision-block", { timeout: 20_000 });
          await page.waitForTimeout(120);
        };
        const closeCard = async () => {
          if (!(await page.evaluate(() => Boolean(document.querySelector(".rowchip-pop"))))) return;
          // Escape is the popup's own gesture, but it is bound where the KEY lands: a page-blurred card hears nothing,
          // so the proof focuses a control inside it first - which is what opening the card does for a real reader.
          await page.evaluate(() => document.querySelector(".rowchip-pop button")?.focus());
          await page.keyboard.press("Escape");
          try {
            await page.waitForFunction(() => !document.querySelector(".rowchip-pop"), null, { timeout: 3_000 });
            return;
          } catch {
            // The card would not close on its own key: say so by failing, and still put the page back in order.
            await page.evaluate(() => document.querySelector("[data-rowchip-close]")?.click());
            await page.waitForFunction(() => !document.querySelector(".rowchip-pop"), null, { timeout: 5_000 });
            throw new Error("the card did not close on Escape");
          }
        };
        const readBlock = () =>
          page.evaluate(() => {
            const pop = document.querySelector(".rowchip-pop");
            const el = pop?.querySelector(".collision-block");
            if (!el) return null;
            const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
            return {
              rowKey: el.getAttribute("data-collision-block"),
              key: el.getAttribute("data-collision-pair"),
              lane: el.getAttribute("data-collision-lane"),
              state: text(el.querySelector(".collision-state")),
              sides: [...el.querySelectorAll(".collision-side")].map((s) => ({
                role: s.getAttribute("data-collision-side"),
                mine: s.classList.contains("is-mine"),
                finished: s.classList.contains("is-finished"),
                name: text(s.querySelector(".collision-side-name")),
                task: text(s.querySelector(".collision-task")),
                taskName: text(s.querySelector(".collision-task-name")),
                taskState: text(s.querySelector(".collision-task-state")),
                taskNone: text(s.querySelector(".collision-side-task.is-none")),
              })),
              sections: [...el.querySelectorAll(".collision-acc")].map((s) => ({
                title: text(s.querySelector(".collision-acc-title")),
                key: text(s.querySelector(".collision-acc-key")),
                expanded: s.querySelector(".collision-acc-head")?.getAttribute("aria-expanded") || null,
                bodyShown: !s.querySelector(".collision-acc-body")?.hidden,
              })),
              other: text(el.querySelector(".collision-other b")),
              say: text(el.querySelector(".collision-say")),
              chips: [...el.querySelectorAll(".collision-chip")].map((c) => c.textContent.trim()),
              stood: text(el.querySelector(".collision-stood")),
              pop: (() => {
                const r = pop.getBoundingClientRect();
                return { w: Math.round(r.width), h: Math.round(r.height), scroll: pop.scrollHeight, client: pop.clientHeight };
              })(),
              actionsFit: (() => {
                const pr = pop.getBoundingClientRect();
                return [...el.querySelectorAll(".collision-actions button")].map((b) => {
                  const r = b.getBoundingClientRect();
                  return { label: text(b), above: r.bottom <= pr.bottom + 1 && r.top >= pr.top - 1 };
                });
              })(),
            };
          });
        const cardOn = async (name) => {
          await openCard(name);
          const got = await readBlock();
          await closeCard();
          return got;
        };
        const secKey = (b, title) => (b?.sections || []).find((s) => s.title === title)?.key || "";
        const shotCard = async (file, name) => {
          await openCard(name);
          const clip = await page.evaluate(() => {
            const r = document.querySelector(".rowchip-pop").getBoundingClientRect();
            const x = Math.max(0, Math.round(r.left) - 10);
            const y = Math.max(0, Math.round(r.top) - 10);
            return { x, y, width: Math.min(window.innerWidth - x, Math.round(r.width) + 20), height: Math.min(window.innerHeight - y, Math.round(r.height) + 20) };
          });
          await page.screenshot({ path: path.join(shots, file), clip });
          console.log(`SHOT  ${path.join(shots, file)}`);
          await closeCard();
        };
        const withCollisions = async () => {
          try {
            await page.waitForFunction(
              () => {
                try {
                  const rows = [...state.rows.values()];
                  const by = (n) => rows.find((r) => r.name === n);
                  // The fixture's four pairs are not all one lane: the stood-down seed record was landed by the
                  // proof's own commit, so its two rows carry HISTORY and the six live rows carry the live lane.
                  return (
                    (by("pair-a")?.collisions || []).length > 0 &&
                    (by("pair-b")?.collisions || []).length > 0 &&
                    (by("sib-one")?.collisions || []).length > 0 &&
                    (by("loose-a")?.collisions || []).length > 0 &&
                    (by("stood-c")?.collisionHistory || []).length > 0 &&
                    (by("stood-d")?.collisionHistory || []).length > 0
                  );
                } catch {
                  return false;
                }
              },
              null,
              { timeout: 60_000 },
            );
          } catch (err) {
            // A wait that times out must SAY what the page was holding: a bare "Timeout" sends the next reader hunting
            // for a paint bug when the answer may be that the panel's own scan had not finished, or that the records
            // were attached to the history lane instead of the live one.
            const pageRows = await page.evaluate(() => {
              try {
                return [...state.rows.values()].map((r) => ({ name: r.name, collisions: (r.collisions || []).length, history: (r.collisionHistory || []).length, live: r.live === true }));
              } catch {
                return [];
              }
            });
            const api = await page.evaluate(async () => {
              const r = await fetch("/api/state");
              const snap = await r.json();
              return (snap.projects || []).flatMap((p) => (p.worktrees || []).map((w) => ({ name: w.name, collisions: (w.collisions || []).length, history: (w.collisionHistory || []).length, live: w.live === true })));
            });
            console.log(`      page rows: ${JSON.stringify(pageRows)}`);
            console.log(`      api rows : ${JSON.stringify(api)}`);
            throw err;
          }
        };
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
                a: c.a ? { name: c.a.name, path: c.a.path, branch: c.a.branch, taskId: c.a.taskId ?? null, task: c.a.task || null } : null,
                b: c.b ? { name: c.b.name, path: c.b.path, branch: c.b.branch, taskId: c.b.taskId ?? null, task: c.b.task || null } : null,
                files: c.files,
                relations: (c.relations || []).map((x) => x.kind),
                source: c.source,
                stoodDown: c.stoodDown || [],
                stoodByTask: c.stoodByTask || [],
                ruling: c.ruling ? { name: c.ruling.name, pick: c.ruling.pick } : null,
                canAsk: c.canAsk,
              })),
              collisionHistory: (r.collisionHistory || []).map((c) => ({ key: c.key, files: c.files, state: c.state, superseded: c.superseded || null })),
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
                  finished: s.classList.contains("is-finished"),
                  name: (s.querySelector(".collision-side-name")?.textContent || "").trim(),
                  task: (s.querySelector(".collision-task")?.textContent || "").trim(),
                  taskName: (s.querySelector(".collision-task-name")?.textContent || "").trim(),
                  taskWho: (s.querySelector(".collision-task-who")?.textContent || "").trim(),
                  taskState: (s.querySelector(".collision-task-state")?.textContent || "").trim(),
                  taskNone: (s.querySelector(".collision-side-task.is-none")?.textContent || "").trim(),
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
        // A shot of the pair's OWN two rows, stacked: the full page is 3 500 px of one project, and a reader opening
        // the proof wants the two cards that are being compared side by side, not a scroll.
        const shotRows = async (file, names) => {
          // Collapse to the pair being shown first: a shot that keeps every other row open is a scroll with two cards
          // somewhere in it.
          await page.evaluate((ns) => {
            state.expanded.clear();
            for (const r of state.rows.values()) if (ns.includes(r.name)) hotOpenPath(r);
            renderAll();
          }, names);
          await page.waitForTimeout(120);
          const box = await page.evaluate((ns) => {
            const els = [...document.querySelectorAll("tr.detail[data-detail]")].filter((tr) => ns.some((n) => (tr.getAttribute("data-detail") || "").endsWith(n)));
            if (!els.length) return null;
            const rects = els.map((e) => e.getBoundingClientRect());
            const top = Math.min(...rects.map((r) => r.top + window.scrollY));
            const bottom = Math.max(...rects.map((r) => r.bottom + window.scrollY));
            return { x: 0, y: Math.max(0, top - 6), width: window.innerWidth, height: Math.min(bottom - top + 12, 1600) };
          }, names);
          if (!box) return;
          await page.screenshot({ path: path.join(shots, file), fullPage: true, clip: box });
          console.log(`SHOT  ${path.join(shots, file)}`);
        };

        // A console error is reported by URL as well as by message: a bare "404" leaves the next reader guessing which
        // resource the page wanted. Attached BEFORE the first navigation, so the load's own requests are on it too.
        page.on("response", (r) => {
          if (r.status() >= 400) console.log(`      HTTP ${r.status()} ${r.url()}`);
        });
        await openPage(page, panel.base, { selector: "header.topbar #btn-human" });
        await rowsLoaded();
        // A group and a project both start collapsed, and a collapsed project paints no row: the marker count, the
        // diamonds and every card below need the rows actually drawn.
        await expandAll();
        await page.waitForTimeout(300);

        // ---- 1. one pair, one record, drawn on both rows ---------------------------------------------------
        section("one pair, one record, drawn on both rows");
        const first = await sweepUntilPairs(4);
        ok("the sweep found exactly four pairs", first?.report?.pairs === 4, JSON.stringify(first?.report ? { pairs: first.report.pairs } : first));
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

        // The cards are behind each row's diamond: open each one in turn and read what it drew.
        const cardA = await cardOn("pair-a");
        const cardB = await cardOn("pair-b");
        eq(
          "each row's diamond opens ONE card, and it is that row's own",
          [cardA?.rowKey?.endsWith("pair-a"), cardB?.rowKey?.endsWith("pair-b"), cardA?.key === pairKey, cardB?.key === pairKey],
          [true, true, true, true],
        );
        // Both cards name the same two trees, with this row's own side marked: the counterpart is named on BOTH.
        for (const [label, b] of [["pair-a", cardA], ["pair-b", cardB]]) {
          const names = b.sides.map((s) => s.name).sort();
          eq(`the card on ${label} names both trees`, names, ["pair-a", "pair-b"]);
          eq(`…with its own side marked on ${label}`, b.sides.filter((s) => s.mine).map((s) => s.name), [label]);
          eq(`…and the counterpart named in the heading on ${label}`, b.other, label === "pair-a" ? "pair-b" : "pair-a");
          ok(`…with the shared file as the evidence on ${label}`, b.chips.includes("lib/shared.js"), JSON.stringify(b.chips));
        }
        eq("eight rows wear a marker, one per side of four pairs", v.marks.filter((m) => m.mark).length, 8);
        // ---- ABOVE THE FOLD: the two ruling presses, with no scroll -------------------------------------------
        for (const [label, b] of [["pair-a", cardA], ["pair-b", cardB]]) {
          const presses = b.actionsFit.filter((a) => /goes first/.test(a.label));
          ok(`both order presses are drawn on ${label}'s card`, presses.length === 2, JSON.stringify(b.actionsFit));
          ok(`…and both sit inside the card's own box, above the fold`, presses.every((a) => a.above), JSON.stringify(presses));
          ok(`…with no scroll needed to reach them`, b.pop.scroll <= b.pop.client + 1, JSON.stringify(b.pop));
        }
        // ---- FOUR CLOSED SECTIONS, each header carrying its own one line --------------------------------------
        eq("the card is a summary over four sections", cardA.sections.map((s) => s.title), ["This row", "Counterpart", "Merge check", "History"]);
        eq("…every one of them closed until asked", cardA.sections.map((s) => [s.expanded, s.bodyShown]), [["false", false], ["false", false], ["false", false], ["false", false]]);
        for (const [label, b] of [["pair-a", cardA], ["pair-b", cardB]]) {
          // "This row" is the card's OWN side, so the queue line swaps with the row the card is drawn on.
          const own = label === "pair-a" ? "#7 · Assistant #1 · running" : "#8 · Assistant #2 · queued";
          const other = label === "pair-a" ? "#8 · Assistant #2 · queued" : "#7 · Assistant #1 · running";
          eq(`a closed section still names this side's task and queue on ${label}`, secKey(b, "This row"), own);
          eq(`…and the counterpart's on ${label}`, secKey(b, "Counterpart"), other);
          ok(`…and the merge check's own verdict on ${label}`, /shared file/.test(secKey(b, "Merge check")), secKey(b, "Merge check"));
          eq(`…and history says there is nothing stood down on ${label}`, secKey(b, "History"), "nothing stood down");
        }
        // ---- A KEYBOARD READER CAN WORK THE CARD --------------------------------------------------------------
        // The header is a real <button>, so Tab reaches it and Enter/Space press it; the card must stay open while a
        // section opens, and Escape must still close the card and hand the caret back to the diamond that opened it.
        await openCard("pair-a");
        const kbStart = await page.evaluate(() => {
          const head = document.querySelector(".rowchip-pop .collision-acc-head");
          head.focus();
          return { focused: document.activeElement === head, expanded: head.getAttribute("aria-expanded"), title: (head.querySelector(".collision-acc-title")?.textContent || "").trim() };
        });
        eq("Tab reaches a section header, closed", [kbStart.focused, kbStart.expanded, kbStart.title], [true, "false", "This row"]);
        await page.keyboard.press("Enter");
        const kbOpen = await page.evaluate(() => {
          const sec = document.querySelector(".rowchip-pop .collision-acc");
          return {
            expanded: sec.querySelector(".collision-acc-head").getAttribute("aria-expanded"),
            shown: !sec.querySelector(".collision-acc-body").hidden,
            cardStillOpen: Boolean(document.querySelector(".rowchip-pop")),
            chevron: (sec.querySelector(".collision-acc-chev")?.textContent || "").trim(),
          };
        });
        eq("Enter opens the section without closing the card", [kbOpen.expanded, kbOpen.shown, kbOpen.cardStillOpen], ["true", true, true]);
        eq("…and the chevron turns to point down", kbOpen.chevron, "\u25be");
        await page.keyboard.press("Space");
        const kbShut = await page.evaluate(() => {
          const sec = document.querySelector(".rowchip-pop .collision-acc");
          return { expanded: sec.querySelector(".collision-acc-head").getAttribute("aria-expanded"), shown: !sec.querySelector(".collision-acc-body").hidden, cardStillOpen: Boolean(document.querySelector(".rowchip-pop")) };
        });
        eq("Space closes it again, still without closing the card", [kbShut.expanded, kbShut.shown, kbShut.cardStillOpen], ["false", false, true]);
        await page.keyboard.press("Escape");
        const kbOut = await page.evaluate(() => ({
          card: Boolean(document.querySelector(".rowchip-pop")),
          onDiamond: Boolean(document.activeElement?.hasAttribute?.("data-collision-diamond")),
          stored: (() => {
            try {
              return [...wm.openRowChips];
            } catch {
              return [];
            }
          })(),
        }));
        eq("Escape closes the card and puts the caret back on the diamond", [kbOut.card, kbOut.onDiamond, kbOut.stored.length], [false, true, 0]);
        // Two real queue files on disk (Assistant #1's and Assistant #2's), matched on each row's own `worktree`
        // field: this is the distinction the card exists for - two agents on ONE piece of work, or two agents merely
        // both landing into main. The summary carries the number, the title and the state; the assistant whose queue
        // holds it is the section header's, which is where a reader looks for who to talk to.
        const sidesOf = (b) => Object.fromEntries((b?.sides || []).map((s) => [s.name, s]));
        for (const [label, b] of [[ "pair-a", cardA ], [ "pair-b", cardB ]]) {
          const sides = sidesOf(b);
          eq(`the card on ${label} names this side's task`, [sides["pair-a"]?.task, sides["pair-a"]?.taskName, sides["pair-a"]?.taskState], ["#7", "Land the collision card on both rows", "running"]);
          eq(`…and the counterpart's task on ${label}`, [sides["pair-b"]?.task, sides["pair-b"]?.taskName, sides["pair-b"]?.taskState], ["#8", "Show each side's task beside its tree", "queued"]);
        }
        eq("the record holds both sides' tasks, with the assistant each belongs to", [rowA?.collisions[0]?.a?.task?.id, rowA?.collisions[0]?.a?.task?.assistant, rowA?.collisions[0]?.b?.task?.id, rowA?.collisions[0]?.b?.task?.assistant, rowA?.collisions[0]?.b?.task?.state], [7, "Assistant #1", 8, "Assistant #2", "queued"]);
        await shotCard("collision-pairs-tasks-1440x900.png", "pair-a");
        await page.screenshot({ path: path.join(shots, "collision-pairs-board-1440x900.png"), fullPage: true });
        console.log(`SHOT  ${path.join(shots, "collision-pairs-board-1440x900.png")}`);
        await shotCard("collision-pairs-both-rows-1440x900.png", "pair-b");

        // ---- 2. a pair a landing ended, kept as history ------------------------------------------------------
        section("a landed pair, kept as history");
        const stoodC = v.rows.find((r) => r.name === "stood-c");
        const stoodD = v.rows.find((r) => r.name === "stood-d");
        eq("both rows carry the same record in the history lane", [stoodC?.collisionHistory?.[0]?.key === stoodD?.collisionHistory?.[0]?.key, Boolean(stoodC?.collisionHistory?.[0]?.key)], [true, true]);
        eq("…and neither counts it as a live collision", [(stoodC?.collisions || []).length, (stoodD?.collisions || []).length], [0, 0]);
        const stoodCards = [await cardOn("stood-c"), await cardOn("stood-d")];
        eq("the card is drawn once on each of its two rows, in the history lane", stoodCards.map((b) => [b?.lane, /stood-[cd]$/.test(b?.rowKey || "")]), [["history", true], ["history", true]]);
        ok("both cards say which side stood down and why", stoodCards.every((b) => /stood-c stood down: its notice #51 was done/.test(b.stood)), JSON.stringify(stoodCards.map((b) => b.stood)));
        eq("…and each names the counterpart", stoodCards.map((b) => b.other).sort(), ["stood-c", "stood-d"]);
        ok("…with the state pill naming the commit that ended it", stoodCards.every((b) => /^superseded by [0-9a-f]{7,}/.test(b.state)), JSON.stringify(stoodCards.map((b) => b.state)));
        ok("…and no order press on a pair that is over", stoodCards.every((b) => b.actionsFit.filter((a) => /goes first/.test(a.label)).length === 0), JSON.stringify(stoodCards.map((b) => b.actionsFit)));
        await shotCard("collision-pairs-stood-down-1440x900.png", "stood-c");

        // ---- 3. two branches from one parent, caught against each other -------------------------------------
        section("a sibling pair");
        const sibOne = v.rows.find((r) => r.name === "sib-one");
        const sibTwo = v.rows.find((r) => r.name === "sib-two");
        eq("the siblings are ONE pair, keyed the same on both rows", [sibOne?.collisions.length, sibTwo?.collisions.length, sibOne?.collisions[0]?.key === sibTwo?.collisions[0]?.key], [1, 1, true]);
        // The detector files these two as SIBLINGS under main - one relation, not two collisions with the parent. The
        // once-per-record overlap measurement then replaces the relation list with the measured shared-file one (the
        // store's `rememberEvidence`), so which of the two words survives depends on that order. Either word says the
        // same thing about THIS pair, and the file and the counterpart are pinned separately below.
        const sibRel = sibOne?.collisions[0]?.relations || [];
        ok("…classified as a sibling pair under main, or by the measured file both changed", sibRel.includes("sibling") || sibRel.includes("shared-file"), JSON.stringify(sibRel));
        eq("…and never as two collisions with the parent", sibRel.filter((k) => k === "merge-target").length, 0);
        eq("…on the committed file both branches change", sibOne?.collisions[0]?.files, ["src/sibling.js"]);
        eq("…each naming the other", [sibOne?.collisions[0]?.other, sibTwo?.collisions[0]?.other], ["sib-two", "sib-one"]);
        ok("…and the primary checkout is NOT one of their pair", ![sibOne?.collisions[0]?.a?.name, sibOne?.collisions[0]?.b?.name].includes("pair-proj"));
        await shotCard("collision-pairs-siblings-1440x900.png", "sib-one");
        // A SIDE WHOSE OWN TASK IS DONE. sib-one's queue row #61 is done, so the card names it and reads as stood
        // down on BOTH rows - and the pair is not counted for the reader, because finished work is not something
        // anybody has to arbitrate. The reason is the History section's; the pill says the state in one word.
        const sibKey = sibOne?.collisions[0]?.key;
        {
          const sibCards = [await cardOn("sib-one"), await cardOn("sib-two")];
          eq("the sibling pair is drawn on both its rows", sibCards.map((b) => Boolean(b)), [true, true]);
          for (const b of sibCards) {
            const sides = Object.fromEntries(b.sides.map((s) => [s.name, s]));
            eq("sib-one's done task is named on the card", [sides["sib-one"]?.task, sides["sib-one"]?.taskName, sides["sib-one"]?.taskState, sides["sib-one"]?.finished], ["#61", "Compare the two siblings", "done", true]);
            eq("…and sib-two's live task beside it", [sides["sib-two"]?.task, sides["sib-two"]?.taskName, sides["sib-two"]?.taskState], ["#62", "Rewrite the shared module", "queued"]);
            const own = /sib-one$/.test(b.rowKey) ? "#61 · Assistant #1 · done" : "#62 · Assistant #2 · queued";
            eq("…with the assistant whose queue holds this side's task on the closed header", secKey(b, "This row"), own);
            eq("…and the card reads as stood down, in one word", b.state, "stood down");
            eq("…with the task number in the History header", secKey(b, "History"), "#61 done");
            ok("…and the sentence saying why inside History", /sib-one is already stood down: its task #61 \(Compare the two siblings\) is done - the collision is with finished work, so the pair is not waiting on you/.test(b.stood), b.stood);
            eq("…which stays closed until the reader asks", b.sections.find((s) => s.title === "History")?.expanded, "false");
          }
          eq("the record names the finished side on both rows", [sibOne?.collisions[0]?.stoodByTask?.map((f) => [f.side, f.taskId, f.state]), sibTwo?.collisions[0]?.stoodByTask?.map((f) => [f.side, f.taskId, f.state])], [[["a", 61, "done"]], [["a", 61, "done"]]]);
          eq("…and the pair is NOT in the reader's rotation", v.list.filter((q) => q.kind === "collision").map((q) => q.key).includes(sibKey), false);
        }
        await shotCard("collision-pairs-done-side-1440x900.png", "sib-two");

        // ---- a side with NO owning queue row says so, in words ------------------------------------------------
        section("a side with no task row");
        const looseA = v.rows.find((r) => r.name === "loose-a");
        const looseB = v.rows.find((r) => r.name === "loose-b");
        eq("the no-row pair is one record on both rows", [looseA?.collisions.length, looseB?.collisions.length, looseA?.collisions[0]?.key === looseB?.collisions[0]?.key], [1, 1, true]);
        const looseKey = looseA?.collisions[0]?.key;
        const looseCards = [await cardOn("loose-a"), await cardOn("loose-b")];
        eq("…drawn once on each of its rows", looseCards.map((b) => Boolean(b)), [true, true]);
        for (const b of looseCards) {
          const sides = Object.fromEntries(b.sides.map((s) => [s.name, s]));
          eq("the side nothing owns says exactly that", [sides["loose-a"]?.taskNone, sides["loose-a"]?.task, sides["loose-a"]?.taskName], ["no task row on this tree", "", ""]);
          eq("…and the side a queue row does own still names its task", [sides["loose-b"]?.task, sides["loose-b"]?.taskName, sides["loose-b"]?.taskState], ["#71", "Rewrite the loose end", "queued"]);
          // On loose-a's card the COUNTERPART is loose-b, the one a queue row owns; on loose-b's card the counterpart
          // is loose-a, and the closed header says in words that nothing owns it.
          const counterpart = /loose-a$/.test(b.rowKey) ? "#71 · Assistant #2 · queued" : "no task row on this tree";
          eq("…with the counterpart's line on the closed header", secKey(b, "Counterpart"), counterpart);
        }
        eq("the record holds null for the unowned side and the row for the other", [looseA?.collisions[0]?.a?.task, looseA?.collisions[0]?.b?.task?.id], [null, 71]);
        await shotCard("collision-pairs-no-row-1440x900.png", "loose-b");

        // ---- 4. the merge-target-only case files nothing ----------------------------------------------------
        section("the merge-target-only case");
        const primary = v.rows.find((r) => r.name === "pair-proj");
        ok("the primary checkout is live and dirty on a file no tree touches", primary?.live === true);
        eq("the book holds four records, one per evidence pair", (await page.evaluate(async () => (await (await fetch("/api/collisions")).json()).total)), 4);
        eq("…and it carries NO collision of its own", primary?.collisions?.length ?? -1, 0);
        eq("…and wears no marker", v.marks.find((m) => m.row && m.row.endsWith("pair-proj"))?.mark ?? "", "");
        const all = await page.evaluate(async () => (await (await fetch("/api/collisions")).json()).records || []);
        eq("no record on the book is a merge-target relation alone", all.filter((r) => (r.relations || []).length && r.relations.every((x) => x.kind === "merge-target")).length, 0);
        eq("four records for four evidence pairs", all.length, 4);
        await shotCard("collision-pairs-merge-target-only-1440x900.png", "pair-a");

        // ---- 5. the ruling, from the row the reader is looking at -------------------------------------------
        section("the reader rules on the pair");
        const mineRole = rowA?.collisions[0]?.role === "b" ? "b" : "a";
        await openCard("pair-a");
        const pressed = await page.evaluate(
          ({ k, pick }) => {
            const el = document.querySelector(`.rowchip-pop [data-collision-rule="${CSS.escape(k)}"][data-collision-pick="${pick}"]`);
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
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(200);
        v = await view();
        const ruledA = v.rows.find((r) => r.name === "pair-a")?.collisions[0];
        const ruledB = v.rows.find((r) => r.name === "pair-b")?.collisions[0];
        eq("both rows read it as ruled", [ruledA?.state, ruledB?.state], ["ruled", "ruled"]);
        eq("the ruling names the tree the reader pressed, on both rows", [ruledA?.ruling?.name, ruledB?.ruling?.name], ["pair-a", "pair-a"]);
        const ruledCards = [await cardOn("pair-a"), await cardOn("pair-b")];
        ok("both cards say already ruled", ruledCards.every((b) => /already ruled: pair-a( \(#\d+\))? goes first/.test(b.state)), JSON.stringify(ruledCards.map((b) => b.state)));
        eq("the pair's sides carry a queue task id when the panel filed one", [rowA?.collisions[0]?.a?.taskId, rowA?.collisions[0]?.b?.taskId].map((x) => (x === null || typeof x === "number" ? "ok" : "bad")), ["ok", "ok"]);
        await shotCard("collision-pairs-ruled-1440x900.png", "pair-b");

        // ---- 6. the badge counts decisions, and a re-detection does not ask again ---------------------------
        section("the badge, and a re-detection");
        await page.waitForTimeout(COLLISION_PASS_MS + 600);
        const again = await swept();
        ok("the sweep still sees four pairs", again?.report?.pairs === 4, JSON.stringify(again?.report ? { pairs: again.report.pairs } : again));
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
