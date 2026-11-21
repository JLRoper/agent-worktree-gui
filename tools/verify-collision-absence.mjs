// tools/verify-collision-absence.mjs - a collision whose counterpart resolves to NO row and to NO live agent, driven in
// a real browser against a real panel. HARNESS: LIVE GATE - `npm run verify:collision-absence` is how the repo runs it.
//
//   node tools/verify-collision-absence.mjs                # boot a throwaway panel and drive it
//   node tools/verify-collision-absence.mjs --root <tree>  # serve a `git archive` of another build (RED PROOF)
//   node tools/verify-collision-absence.mjs --shots <dir>  # write the screenshots there (default .shots/)
//
// WHAT IT PROVES, at 1440x900 against a fixture that is REAL git:
//
//   1. the worker's COLLISION line naming a tree the board does not have is recorded as a VERDICT (state `absent`),
//      with the words it was written with and no reader hand-over - not dropped, and not filed as a question;
//   2. the row still carries the report, and the card prints it as settled with NO ruling press and NO ask press,
//      so the reader is not offered a ruling that does not exist;
//   3. THE HUMAN COUNT: the same board holds one pair the reader CAN rule on and the absent note, and the badge says
//      "1 collision" - the absent record does not add a count, and H never steps into it;
//   4. a later pass does not reopen it: the second sweep leaves it `absent`, so it cannot become the reader's work by
//      the panel's own clock.
//
// WHAT IT DOES NOT PROVE: the queue rows or the escalation arithmetic (test/collisions.test.js and
// test/collision-card.test.js do that), and the marker's own copy, which the card assertions here read from the block.
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

// ---- the fixture: one project, two dirty worktrees (the pair) and a name nobody answers to (the absence) ------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-collision-absent-"));
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
writeFileSync(path.join(repo, "README.md"), "# collision absence fixture\n");
mkdirSync(path.join(repo, "lib"), { recursive: true });
writeFileSync(path.join(repo, "lib", "shared.js"), "export const shared = 1;\n");
git(["add", "-A"]);
git(["commit", "-m", "fixture"]);
const ONE = path.join(repo, ".worktrees", "coll-one-aaaa").replace(/\\/g, "/");
const TWO = path.join(repo, ".worktrees", "coll-two-bbbb").replace(/\\/g, "/");
git(["worktree", "add", "-b", "wtgui/coll-one", ONE]);
git(["worktree", "add", "-b", "wtgui/coll-two", TWO]);
// The pair the reader can rule on: the same file dirty in both trees.
writeFileSync(path.join(ONE, "lib", "shared.js"), "export const shared = 'one';\n");
writeFileSync(path.join(TWO, "lib", "shared.js"), "export const shared = 'two';\n");

// ---- two worker lines through the real harvest seam, before the panel boots -----------------------------------------
const BOOK_FILE = path.join(dir, "logs", "collisions.json");
const book = new CollisionBook({ file: BOOK_FILE, log: (m) => console.log(`      book: ${m}`) });
const rowSkeleton = (p, branch, name, project = "coll-proj") => ({ project, path: p, branch, name, live: true });
const harness = Object.create(Jobs.prototype);
harness.collisions = book;
harness.push = () => {};
harness.getRows = () => [rowSkeleton(ONE, "wtgui/coll-one", "coll-one"), rowSkeleton(TWO, "wtgui/coll-two", "coll-two")];
// No job store on the harness, so `liveAgentTrees()` answers an EMPTY LIST - the harvester looked and nobody is there.
// That is the case under test; `null` (not looked) is pinned in test/collision-card.test.js.
const note = (id, text, target) =>
  harness.harvestCollisions(
    {
      id,
      thread: `${id}-thread`,
      project: "coll-proj",
      status: "done",
      endedAt: "2026-11-18T09:00:00.000Z",
      finalMessage: ["The work is built and the branch is pushed.", "", `COLLISION ${target} | ${text}`].join("\n"),
    },
    { path: ONE, branch: "wtgui/coll-one" },
  );

const PAIR_NOTE = "both of us are rewriting lib/shared.js - I only need the export name settled";
const pairFiled = note("runcollpair", PAIR_NOTE, "coll-two");
const ABSENT_NOTE = "something in that tree is rewriting the same file and I cannot see whose it is";
const absentFiled = note("runcollghost", ABSENT_NOTE, "coll-ghost-cccc");
ok("both worker lines were read", pairFiled?.noted === 1 && absentFiled?.noted === 1, `pair ${pairFiled?.noted}, absent ${absentFiled?.noted}`);
const records = [...book.all()];
const seededPair = records.find((r) => r.b?.path === TWO) || null;
const seededAbsent = records.find((r) => r.bTarget === "coll-ghost-cccc") || null;
ok(
  "the pair resolved to the other row, and is nobody's until the sweep hands it over",
  Boolean(seededPair) && seededPair.a?.path === ONE && seededPair.readerAt === null,
  seededPair ? `${seededPair.a?.name} / ${seededPair.b?.name}` : "no pair record",
);
ok(
  "the ghost target is a VERDICT on the record: absent, with no reader hand-over and no live agent",
  Boolean(seededAbsent) && seededAbsent.absent?.target === "coll-ghost-cccc" && !seededAbsent.readerAt && !seededAbsent.b && !seededAbsent.ruling,
  seededAbsent ? `absent ${JSON.stringify(seededAbsent.absent)} readerAt ${seededAbsent.readerAt}` : "no absent record",
);
const ABSENT_KEY = seededAbsent?.key || "";

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
        const sweepUntilPair = async (want = 1) => {
          for (let i = 0; i < 30; i += 1) {
            const out = await swept();
            if (out?.report?.pairs === want) return out;
            await page.waitForTimeout(1000);
          }
          return swept();
        };
        // The pair is the reader's on a second pass with nobody standing down (collision-flow.js `no-stand-down`). A
        // proof does not assert on which tick that lands, so it asks until the store says so, bounded, exactly as the
        // panel's own ten-second clock would do it.
        const sweepUntilReader = async () => {
          for (let i = 0; i < 30; i += 1) {
            const out = await swept();
            const book = await page.evaluate(async () => (await fetch("/api/collisions")).json());
            if (Number(book?.counts?.reader) === 1) return { sweep: out, book };
            await page.waitForTimeout(COLLISION_PASS_MS + 600);
          }
          return { sweep: null, book: await page.evaluate(async () => (await fetch("/api/collisions")).json()) };
        };
        // The button repaints on the page's own clock and boots from index.html's static title, so every read waits.
        const painted = () =>
          page.waitForFunction(
            () => {
              const btn = document.getElementById("btn-human");
              // index.html's STATIC title is the one that says "every open permission"; the painted one names the
              // counts. Waiting on that difference needs no dash of its own.
              return Boolean(btn && btn.title && !/every open permission/.test(btn.title));
            },
            null,
            { timeout: 20_000 },
          );
        const view = () =>
          page.evaluate(() => {
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
              rows: [...state.rows.values()].map((r) => ({
                path: r.path,
                name: r.name,
                collisions: (r.collisions || []).map((c) => ({ key: c.key, state: c.state, absent: c.absent ? c.absent.target : null })),
              })),
              badge: (badge?.textContent || "").trim(),
              badgeHidden: badge ? badge.hidden : null,
              label: (label?.textContent || "").trim(),
              title: btn?.title || "",
              list,
              humanKey: state.human.key,
              blocks: [...document.querySelectorAll("[data-collision-block]")].map((el) => ({
                key: el.getAttribute("data-collision-key"),
                state: (el.querySelector(".collision-state")?.textContent || "").trim(),
                say: (el.querySelector(".collision-say")?.textContent || "").trim(),
                absentLine: (el.querySelector("[data-collision-absent]")?.textContent || "").trim(),
                peer: (el.querySelector(".collision-peer")?.textContent || "").trim(),
                resol: el.querySelector("[data-collision-resolution]")?.getAttribute("data-collision-resolution") || null,
                rules: [...el.querySelectorAll("[data-collision-rule]")].length,
                asks: [...el.querySelectorAll("[data-collision-ask]")].length,
                cls: [...el.classList].filter((c) => c.startsWith("is-")).join(","),
              })),
              marks: [...document.querySelectorAll("tr.row .collision-mark")].map((el) => ({
                state: [...el.classList].filter((c) => c.startsWith("is-")).join(","),
                title: el.getAttribute("title") || "",
              })),
            };
          });

        await openPage(page, panel.base, { selector: "header.topbar #btn-human" });
        await rowsLoaded();
        // A 404 that the page makes for a resource nobody asked about (the favicon is one) is not this gate's business;
        // any OTHER failed request is, so the URLs are kept and asserted on below rather than only the console string.
        const failed = [];
        page.on("response", (r) => {
          if (r.status() >= 400 && !/favicon/i.test(r.url())) failed.push(`${r.status()} ${r.url()}`);
        });

        // ---- 1. the pair is detected and handed over, and the absence is on the book ---------------------------
        section("one pair, and one name nobody answers to");
        const first = await sweepUntilPair();
        ok("the sweep found the pair", first?.report?.pairs === 1, JSON.stringify(first?.report ? { pairs: first.report.pairs } : first));
        const handed = await sweepUntilReader();
        ok("the pair was handed to the reader by the panel's own pass", Number(handed.book?.counts?.reader) === 1, JSON.stringify(handed.book?.counts));
        await page.reload({ waitUntil: "domcontentloaded" });
        await rowsLoaded();
        await painted();
        const bookNow = await page.evaluate(async () => (await fetch("/api/collisions")).json());
        const absentRec = (bookNow.records || []).find((r) => r.key === ABSENT_KEY) || null;
        ok(
          "the absent note is on the book, in state `absent`, and the endpoint counts it as a state of its own",
          absentRec?.state === "absent" && absentRec?.absent?.target === "coll-ghost-cccc" && absentRec?.readerAt === null,
          absentRec ? `state ${absentRec.state} / readerAt ${absentRec.readerAt}` : "no record",
        );
        ok("…and the states list names it", (bookNow.states || []).includes("absent"), JSON.stringify(bookNow.states));
        // THE COUNT, at the endpoint: two records, one decision. The absence has a state and no count of its own in
        // the reader's number - that is the arithmetic the header badge is drawn from.
        ok(
          "…counted apart from the reader's",
          Number(bookNow.counts?.absent) === 1 && Number(bookNow.count) === Number(bookNow.counts?.reader) && Number(bookNow.count) === 1,
          JSON.stringify({ count: bookNow.count, counts: bookNow.counts }),
        );

        // ---- 2. the row carries the report and the card prints it as settled, with nothing to press -------------
        section("the card, and no press on it");
        // THE CARD IS THE CHIP'S POPUP (public/board-scaffold.js `rowChipInner`), not the row detail: the press that
        // opens it is the chip's own, so the gate presses the chip the reader would press.
        const opened = await page.evaluate((p) => {
          const entry = [...state.rows.entries()].find(([, r]) => r.path === p);
          if (!entry) return "no row";
          const [key, row] = entry;
          hotOpenPath(row);
          renderAll();
          const chip = document.querySelector(`tr.row[data-key="${CSS.escape(key)}"] [data-rowchip="collision"]`);
          if (!chip) return "no chip";
          chip.click();
          return "clicked";
        }, ONE);
        eq("the collision chip is on the reporting row, and the press opened it", opened, "clicked");
        await page.waitForTimeout(500);
        let v = await view();
        const oneRow = v.rows.find((r) => r.path === ONE);
        const twoRow = v.rows.find((r) => r.path === TWO);
        eq("the reporting row carries both records", [oneRow?.collisions.length, twoRow?.collisions.length], [2, 1]);
        eq("the reporting row's absent record reads `absent`", oneRow?.collisions.find((c) => c.key === ABSENT_KEY)?.state, "absent");
        const absentBlock = v.blocks.find((b) => b.key === ABSENT_KEY) || null;
        ok("the card is drawn for it, settled", Boolean(absentBlock) && /resolved by absence/.test(absentBlock.state), absentBlock ? absentBlock.state : "no block");
        ok("…carrying the verdict line, not a fresh alarm", /recorded as resolved by absence/.test(absentBlock?.absentLine || ""), String(absentBlock?.absentLine).slice(0, 120));
        ok("…with the absent class, not the reader's strong one", /is-absent/.test(absentBlock?.cls || "") && !/is-reader/.test(absentBlock?.cls || ""), String(absentBlock?.cls));
        ok("…and the peer line says there is no second side", /no live agent/.test(absentBlock?.peer || "") && /no second side/.test(absentBlock?.peer || ""), String(absentBlock?.peer).slice(0, 160));
        eq("…and NO ruling press and NO ask press", [absentBlock?.rules, absentBlock?.asks], [0, 0]);
        ok("…while the pair's own card still offers both", v.blocks.some((b) => b.key !== ABSENT_KEY && b.rules > 0), JSON.stringify(v.blocks.map((b) => [b.key, b.rules, b.asks])));

        // ---- 3. THE HUMAN COUNT: one decision on the board, and the badge says one -------------------------------
        section("the Human count without it");
        eq("the badge counts the pair only", [v.badge, v.badgeHidden], ["1", false]);
        ok("…and its title says one collision, not two", /1 collision/.test(v.title) && !/2 collisions/.test(v.title), v.title.slice(0, 140));
        eq("…the rotation holds one collision item", v.list.filter((q) => q.kind === "collision").length, 1);
        ok("…and it is not the absent record", v.list.every((q) => q.kind !== "collision" || q.key !== `collision:${ABSENT_KEY}`), JSON.stringify(v.list));

        await page.screenshot({ path: path.join(shots, "collision-absence-1440x900.png"), fullPage: true });
        console.log(`SHOT  ${path.join(shots, "collision-absence-1440x900.png")}`);

        // ---- 4. a later pass leaves it settled ------------------------------------------------------------------
        section("a pass later, still settled");
        await page.waitForTimeout(COLLISION_PASS_MS + 600);
        await swept();
        const later = await page.evaluate(async () => (await fetch("/api/collisions")).json());
        const still = (later.records || []).find((r) => r.key === ABSENT_KEY) || null;
        ok("the absent record is unchanged by the panel's own clock", still?.state === "absent" && still?.readerAt === null, still ? `state ${still.state}` : "no record");
        await page.reload({ waitUntil: "domcontentloaded" });
        await rowsLoaded();
        await painted();
        v = await view();
        eq("…and the badge still counts the pair alone", [v.badge, v.badgeHidden], ["1", false]);
        ok("…and the absent record is still drawn as settled", /is-absent/.test(v.marks.map((m) => m.state).join(",")) || v.blocks.some((b) => b.key === ABSENT_KEY && /is-absent/.test(b.cls)), JSON.stringify(v.marks.map((m) => m.state)));

        ok("no page error", pageErrors.length === 0, pageErrors.join(" | "));
        ok("no failed request the panel made", failed.length === 0, failed.join(" | "));
        ok("no console error", consoleErrors.filter((m) => !/Failed to load resource/.test(m)).length === 0, consoleErrors.join(" | "));
        return failures;
      },
      // `channel: "chromium"` runs the FULL chromium build this host has, instead of the headless shell binary, which
      // is not installed beside it. The gate is headless either way.
      { viewport: { width: 1440, height: 900 }, launchOptions: { channel: "chromium" } },
    );
  } catch (err) {
    console.log(`FAIL  the harness itself: ${err && err.stack ? err.stack : err}`);
    failures += 1;
    return failures;
  }
})();

console.log(`\n${failures ? "FAILED" : "OK"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
