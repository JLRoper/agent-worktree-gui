// tools/verify-collisions.mjs - two live trees stepping on each other, and the reader ruling on the pair, driven in a
// real browser against a real panel. HARNESS: LIVE GATE - `npm run verify:collisions` is how the repo runs it by name.
//
//   node tools/verify-collisions.mjs                      # boot a throwaway panel and drive it
//   node tools/verify-collisions.mjs --root <tree>         # serve a `git archive` of another build (RED PROOF)
//   node tools/verify-collisions.mjs --shots <dir>         # write the screenshots there (default .shots/)
//
// WHAT IT PROVES, at 1440x900 against a fixture that is REAL git:
//
//   1. two worktrees of ONE project with the same file dirty are a collision the scan can prove, and BOTH rows wear
//      the violet marker, each naming the other tree and the shared file (never a bare flag);
//   2. the Human button counts the pair ONCE - the same pair is carried by both rows and the badge is a decision
//      count, not a marker count - and its title names "1 collision";
//   3. the pair is handed to the reader by the panel's own pass, not by a fixture flag: two sweeps more than
//      COLLISION_PASS_MS apart with nobody standing down is the second of the three conditions in collision-flow.js;
//   4. H steps into it: the collision card is centred, flashed, and the ruling press takes the caret;
//   5. a worker's COLLISION line is on the same pair - filed against its own tree, resolved to the other row, and read
//      back off the card as the worker's own sentence - because the fixture runs `Jobs.harvestCollisions` against the
//      book the panel boots from, so the parse, the record and the render are one path;
//   6. the ruling stores against the PAIR: the press writes it, both cards re-render as "already ruled: <side> goes
//      first", and a RE-DETECTION after a fresh sweep still reads as already ruled instead of asking again.
//
// WHAT IT DOES NOT PROVE: the queue rows. That is `lib/collision-flow.js` against a fake assistant queue, in
// test/collisions.test.js, because a panel with the assistant disabled has no queue to file into and a panel with it
// enabled would need a live gateway.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, withBrowser, openPage } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";
import { Jobs } from "../lib/jobs.js";
import { CollisionBook, COLLISION_PASS_MS } from "../lib/collisions.js";

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

// ---- the fixture: one project, two worktrees, the same file dirty in both ------------------------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-collisions-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "coll-proj");
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
writeFileSync(path.join(repo, "README.md"), "# collisions fixture\n");
mkdirSync(path.join(repo, "lib"), { recursive: true });
writeFileSync(path.join(repo, "lib", "shared.js"), "export const shared = 1;\n");
git(["add", "-A"]);
git(["commit", "-m", "fixture"]);
const ONE = path.join(repo, ".worktrees", "coll-one-aaaa").replace(/\\/g, "/");
const TWO = path.join(repo, ".worktrees", "coll-two-bbbb").replace(/\\/g, "/");
git(["worktree", "add", "-b", "wtgui/coll-one", ONE]);
git(["worktree", "add", "-b", "wtgui/coll-two", TWO]);
// The same file, uncommitted, in both trees: the ordinary shared-file collision, and the one a reader can act on.
writeFileSync(path.join(ONE, "lib", "shared.js"), "export const shared = 'one';\n");
writeFileSync(path.join(TWO, "lib", "shared.js"), "export const shared = 'two';\n");
// A file only one of them touches: the evidence must say ONE shared file, not two.
writeFileSync(path.join(ONE, "lib", "only-one.js"), "export const mine = true;\n");

// ---- the worker's own COLLISION line, through the real harvest seam ------------------------------------------------
const BOOK_FILE = path.join(dir, "logs", "collisions.json");
const book = new CollisionBook({ file: BOOK_FILE, log: (m) => console.log(`      book: ${m}`) });
// The rows the harvester resolves the target against: the same fields the scanner writes, so `resolveCollisionTarget`
// answers exactly as it would on a live board.
const rowSkeleton = (p, branch, name, project = "coll-proj") => ({ project, path: p, branch, name, live: true });
const harness = Object.create(Jobs.prototype);
harness.collisions = book;
harness.push = () => {};
harness.getRows = () => [rowSkeleton(ONE, "wtgui/coll-one", "coll-one"), rowSkeleton(TWO, "wtgui/coll-two", "coll-two")];
const NOTE = "both of us are rewriting lib/shared.js - I only need the export name settled";
const filed = harness.harvestCollisions(
  {
    id: "runcoll1",
    thread: "coll-thread-one",
    project: "coll-proj",
    status: "done",
    endedAt: "2026-11-18T09:00:00.000Z",
    finalMessage: ["The export is built and the branch is pushed.", "", `COLLISION coll-two | ${NOTE}`].join("\n"),
  },
  { path: ONE, branch: "wtgui/coll-one" },
);
ok("a worker's COLLISION line was read and filed against its own tree", filed?.noted === 1 && filed?.broken === 0, `noted ${filed?.noted}, broken ${filed?.broken}`);
const seeded = [...book.all()][0];
ok(
  "the note resolved to the other row of the same project",
  Boolean(seeded) && seeded.source === "reported" && seeded.a?.path === ONE && seeded.b?.path === TWO && seeded.notes?.[0]?.text === NOTE,
  seeded ? `${seeded.a?.name} / ${seeded.b?.name} / ${seeded.notes?.[0]?.text || "(no note)"}` : "no record",
);

const panel = await startPanel({ root: TREE, dir, keep: true, config: { collisionsFile: BOOK_FILE, assistant: { enabled: false } } });
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
                return state.rows && state.rows.size >= 2;
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
        // finished and see nothing. A proof cannot assert on that race: it asks for a sweep until the detector has the
        // pair, which is the same thing the panel's own 10s clock does, only bounded.
        const sweepUntilPair = async (want = 1) => {
          for (let i = 0; i < 30; i += 1) {
            const out = await swept();
            if (out?.report?.pairs === want) return out;
            await page.waitForTimeout(1000);
          }
          return swept();
        };
        // The button repaints on the page's own clock, and a reload starts with the STATIC title from index.html. Every
        // read of the header waits for the paint, so a number is never read off the markup the page boots with.
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
                return [...state.rows.values()].filter((r) => (r.collisions || []).length > 0).length >= 2;
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
              key: `${r.project}\\u0000${r.path}`,
              name: r.name,
              path: r.path,
              branch: r.branch,
              live: r.live === true,
              collisions: (r.collisions || []).map((c) => ({
                key: c.key,
                state: c.state,
                role: c.role,
                other: c.other?.name || null,
                otherPath: c.other?.path || null,
                files: c.files,
                source: c.source,
                notes: (c.notes || []).map((n) => n.text),
                ruling: c.ruling ? { name: c.ruling.name, pick: c.ruling.pick } : null,
                canAsk: c.canAsk,
              })),
            }));
            const btn = document.getElementById("btn-human");
            const badge = document.getElementById("human-badge");
            const label = document.getElementById("human-label");
            let list = [];
            try {
              list = humanQuestions().map((q) => ({ kind: q.kind, key: q.key, agent: q.agent }));
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
              focus: document.activeElement?.getAttribute?.("data-collision-pick") || document.activeElement?.dataset?.collisionRule || null,
              blocks: [...document.querySelectorAll("[data-collision-block]")].map((el) => ({
                key: el.getAttribute("data-collision-key"),
                state: (el.querySelector(".collision-state")?.textContent || "").trim(),
                say: (el.querySelector(".collision-say")?.textContent || "").trim(),
                chips: [...el.querySelectorAll(".collision-chip")].map((c) => c.textContent.trim()),
                notes: [...el.querySelectorAll(".collision-notes li")].map((c) => c.textContent.trim()),
                when: (el.querySelector(".collision-when")?.textContent || "").trim(),
                other: (el.querySelector(".collision-other b")?.textContent || "").trim(),
              })),
              marks: [...document.querySelectorAll("tr.row .collision-mark")].map((el) => ({
                row: el.closest("tr.row")?.getAttribute("data-key") || null,
                state: [...el.classList].filter((c) => c.startsWith("is-")).join(","),
                title: el.getAttribute("title") || "",
              })),
            };
          });

        await openPage(page, panel.base, { selector: "header.topbar #btn-human" });
        await rowsLoaded();

        // ---- 1. the scan proves the pair, and the sweep files it ------------------------------------------
        section("two dirty trees in one project");
        const first = await sweepUntilPair();
        ok("the sweep found the pair", first?.report?.pairs === 1, JSON.stringify(first?.report ? { pairs: first.report.pairs } : first));
        await page.reload({ waitUntil: "domcontentloaded" });
        await rowsLoaded();
        await withCollisions();
        await painted();
        let v = await view();
        const one = v.rows.find((r) => r.path === ONE);
        const two = v.rows.find((r) => r.path === TWO);
        ok("both rows are live, which is what makes them a pair", one?.live === true && two?.live === true);
        eq("both rows carry the same pair", [one?.collisions.length, two?.collisions.length], [1, 1]);
        eq("…keyed the same, one record", [one?.collisions[0]?.key, two?.collisions[0]?.key], [one?.collisions[0]?.key, one?.collisions[0]?.key]);
        eq("the evidence is the one shared file, not the file only one tree touches", one?.collisions[0]?.files, ["lib/shared.js"]);
        eq("and each row names the OTHER tree", [one?.collisions[0]?.other, two?.collisions[0]?.other], ["coll-two-bbbb", "coll-one-aaaa"]);
        eq("the worker's note rides the same pair", one?.collisions[0]?.notes, [NOTE]);
        eq("…and it is still marked as reported", one?.collisions[0]?.source, "reported");

        // ---- 2. the marker, on both rows, naming the counterpart ------------------------------------------
        section("the marker on both rows");
        // The rows have to be DRAWN before their marks exist: the marker lives in the name cell of a worktree row, and a
        // project the page is showing folded has no rows in the document at all. hotOpenPath is the panel's own opener.
        await page.evaluate(() => {
          for (const r of state.rows.values()) if ((r.collisions || []).length) hotOpenPath(r);
        });
        await page.waitForTimeout(300);
        v = await view();
        const marks = v.marks;
        eq("two row markers, one per row", marks.length, 2);
        ok("each marker names the other tree and the file", marks.every((m) => /collision with coll-(one|two)-[a-z]+/.test(m.title) && /1 shared file/.test(m.title) && /lib\/shared\.js/.test(m.title)), JSON.stringify(marks.map((m) => m.title)));
        ok("the markers are violet, and not the review or turnover mark", marks.every((m) => !/is-(review|turnover)/.test(m.state)), JSON.stringify(marks.map((m) => m.state)));
        eq("both rows are marked at rest", await page.evaluate(() => document.querySelectorAll("tr.row.has-collision").length), 2);

        // ---- 3. the panel's own pass hands the pair over --------------------------------------------------
        section("the pass hands it to the reader");
        await page.waitForTimeout(COLLISION_PASS_MS + 600);
        const second = await swept();
        ok("the second sweep ticked a pass", second?.report?.pairs === 1, JSON.stringify(second?.report ? { pairs: second.report.pairs, escalated: second.report.escalated } : second));
        await page.reload({ waitUntil: "domcontentloaded" });
        await rowsLoaded();
        await withCollisions();
        await painted();
        v = await view();
        eq("the pair is the reader's now, on both rows", [v.rows.find((r) => r.path === ONE)?.collisions[0]?.state, v.rows.find((r) => r.path === TWO)?.collisions[0]?.state], ["reader", "reader"]);

        // ---- 4. the badge counts the pair ONCE, and H steps into it ---------------------------------------
        section("the Human badge, and H");
        eq("the badge counts one decision, not two markers", [v.badge, v.badgeHidden], ["1", false]);
        ok("the title names the collision kind", /1 collision/.test(v.title), v.title.slice(0, 120));
        eq("the rotation holds one collision item", v.list.filter((q) => q.kind === "collision").length, 1);
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.keyboard.press("h");
        await page.waitForTimeout(300);
        const stepped = await view();
        ok("H parked the rotation on the collision", /^collision:/.test(stepped.humanKey || ""), String(stepped.humanKey));
        ok("…and the ruling press has the caret", stepped.focus === "a" || stepped.focus === "b" || Boolean(stepped.focus), JSON.stringify(stepped.focus));
        ok("…on the card, with the pair's evidence", stepped.blocks.length >= 1 && stepped.blocks[0].chips.includes("lib/shared.js"), JSON.stringify(stepped.blocks.map((b) => b.chips)));
        ok("…and the worker's sentence is on it", stepped.blocks.some((b) => b.notes.some((n) => n.includes(NOTE))), JSON.stringify(stepped.blocks.map((b) => b.notes)));
        ok("…marked as reported by its worker", stepped.blocks.some((b) => /reported by its worker/.test(b.when)), JSON.stringify(stepped.blocks.map((b) => b.when)));

        // Both cards on screen for the shot: the row the rotation landed on is open, the other one is opened here.
        await page.evaluate(() => {
          for (const r of state.rows.values()) if ((r.collisions || []).length) hotOpenPath(r);
          renderAll();
        });
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(shots, "collisions-rows-1440x900.png"), fullPage: true });
        console.log(`SHOT  ${path.join(shots, "collisions-rows-1440x900.png")}`);
        await page.locator("#btn-human").screenshot({ path: path.join(shots, "collisions-human-1440x900.png") });
        console.log(`SHOT  ${path.join(shots, "collisions-human-1440x900.png")}`);

        // ---- 5. the ruling ---------------------------------------------------------------------------------
        section("the reader rules");
        const pairKey = (await view()).rows.find((r) => r.path === ONE)?.collisions[0]?.key;
        const mine = await page.evaluate(() => {
          const r = [...state.rows.values()].find((x) => (x.collisions || []).length);
          return r.collisions[0].role === "b" ? "b" : "a";
        });
        // The press is made in the page: the pair key is the store's own (paths, hashed), and a selector built in Node
        // would have to re-escape it a second time.
        const pressed = await page.evaluate(
          ({ k, pick }) => {
            const el = document.querySelector(`[data-collision-rule="${k}"][data-collision-pick="${pick}"]`);
            if (!el) return false;
            el.click();
            return true;
          },
          { k: pairKey, pick: mine },
        );
        ok("the ruling press is on the card", pressed === true, String(pressed));
        await page.waitForFunction(
          (k) => [...state.rows.values()].some((r) => (r.collisions || []).some((c) => c.key === k && c.state === "ruled")),
          pairKey,
          { timeout: 20_000 },
        );
        const ruled = await view();
        const rulerOne = ruled.rows.find((r) => r.path === ONE)?.collisions[0];
        const rulerTwo = ruled.rows.find((r) => r.path === TWO)?.collisions[0];
        eq("both rows read it as ruled", [rulerOne?.state, rulerTwo?.state], ["ruled", "ruled"]);
        eq("the ruling names the side that goes first, on both rows", [rulerOne?.ruling?.name, rulerTwo?.ruling?.name], ["coll-one-aaaa", "coll-one-aaaa"]);
        ok("the card says already ruled", ruled.blocks.every((b) => /already ruled: coll-one-aaaa goes first/.test(b.state)), JSON.stringify(ruled.blocks.map((b) => b.state)));
        ok("…and the marker says so too", ruled.marks.every((m) => /already ruled/.test(m.title)), JSON.stringify(ruled.marks.map((m) => m.title)));
        // The button repaints on the page's own clock, so the quiet badge is waited for rather than read on the press.
        const quieted = await page
          .waitForFunction(() => document.getElementById("human-badge")?.hidden === true, null, { timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        ok("a ruled pair stops waiting on the reader, so the badge goes quiet", quieted, JSON.stringify(await page.evaluate(() => (document.getElementById("human-badge") || {}).hidden)));
        await page.screenshot({ path: path.join(shots, "collisions-ruled-1440x900.png") });
        console.log(`SHOT  ${path.join(shots, "collisions-ruled-1440x900.png")}`);

        // ---- 6. a re-detected pair reads as already ruled ---------------------------------------------------
        section("re-detected, still ruled");
        await page.waitForTimeout(COLLISION_PASS_MS + 600);
        const again = await swept();
        ok("the sweep still sees the pair", again?.report?.pairs === 1, JSON.stringify(again?.report ? { pairs: again.report.pairs } : again));
        const bookNow = await page.evaluate(async () => (await fetch("/api/collisions")).json());
        const rec = (bookNow.records || []).find((r) => r.key === pairKey) || null;
        ok("the record survived the re-detection with its ruling", Boolean(rec) && rec.state === "ruled" && rec.ruling?.name === "coll-one-aaaa", JSON.stringify(rec ? { state: rec.state, ruling: rec.ruling?.name } : null));
        await page.reload({ waitUntil: "domcontentloaded" });
        await rowsLoaded();
        await withCollisions();
        const after = await view();
        ok(
          "and the rows render it as already ruled, not as a fresh alarm",
          after.rows.filter((r) => (r.collisions || []).length).length === 2 && after.rows.filter((r) => (r.collisions || []).length).every((r) => r.collisions[0].state === "ruled"),
          JSON.stringify(after.rows.filter((r) => (r.collisions || []).length).map((r) => r.collisions[0]?.state)),
        );

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
