#!/usr/bin/env node
// THE WAVE LANE, ON THE REAL PAGE, AT 1440 AND AT 768.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-waves-lane.mjs [--shots <dir>]
//
// WHAT THIS GATE PROVES, and why each half is a measurement rather than a look:
//
//   1. THE LANE IS IN THE INITIATIVES TAB. The wave section is drawn inside an initiative card (`.init-wavefold` in
//      `.init-card`), because the reader's fourth decision puts the surface in that tab and refuses a separate Waves
//      tab (docs/reports/waves-of-work.html, section 6).
//   2. EVERY MEMBER'S STATE AND BOTH GATE CHIPS ARE ON SCREEN. Three members read queued, running and done, the wave
//      reads running and is marked current, the entry gate reads met and the exit reads cannot tell - the words the
//      route answered, found by their data attributes rather than by their paint.
//   3. NO HORIZONTAL SCROLL, at 1440 and at 768. Two numbers per width: the pane's own scrollWidth never exceeds its
//      clientWidth, and the DOCUMENT's scrollWidth is the same with the card open as with it closed - so the lane adds
//      no sideways overflow to the page. Every wave box is measured too: a long title or a template id may wrap, and
//      must not widen its row.
//   4. THE THREE MEMBER STATES ARE THE TASKS' OWN. The sandbox files one running, one queued and one done row; the
//      gate reads `data-member-state` and never infers a state from the wave.
//   5. HEALTH: zero page errors and zero console errors.
//
// Sandbox only: its own config, port and state directory, no projects beyond two throwaway git trees it makes, and an
// apiServer pointed at a dead port. The live panel on 7331 and ~/.wag are never touched. Without Playwright the script
// says BROWSER-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { git, post, startPanel, waitForState } from "./panel-testkit.mjs";
import { readQueueFile, writeQueueFile } from "../lib/assistant/queue.js";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const note = (s) => console.log(`      ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

// ---- the sandbox: two projects, one worktree each, and the state a wave reads -------------------------------------
const sandbox = mkdtempSync(path.join(tmpdir(), "wag-waves-lane-"));
const repos = path.join(sandbox, "repos");
mkdirSync(repos, { recursive: true });
const project = (name, tree) => {
  const dir = path.join(repos, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "first"]);
  git(dir, ["worktree", "add", "-q", "-b", tree, path.join(dir, ".worktrees", tree)]);
  return path.join(dir, ".worktrees", tree);
};
const treeA = project("wave-lane-a", "lane-a");
const treeB = project("wave-lane-b", "lane-b");
const wavesFile = path.join(sandbox, "logs", "waves.json");

const panel = await startPanel({
  dir: sandbox,
  config: {
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: 3600,
    scanMode: "all",
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    wavesFile,
  },
});
const base = panel.base;
const GET = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

let shotNo = 0;
const shotName = (slug) => path.join(shotsDir, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);

try {
  console.log(`sandbox: ${base}`);
  console.log(`panel pid: ${panel.pid}`);

  await waitForState(
    base,
    (s) => {
      const rows = s.projects.flatMap((p) => (p.worktrees || []).map((w) => w.path));
      return [treeA, treeB].every((p) => rows.some((r) => r.replace(/\\/g, "/").toLowerCase() === p.replace(/\\/g, "/").toLowerCase()));
    },
    "the two worktrees are on the board",
    { timeout: 120_000 },
  );

  // ---- the fixture: one initiative, one wave of three members, one task outside it ------------------
  console.log("\n== seed ==");
  const tiered = await post(base, "/api/settings/initiative-tier", { body: { tier: "remove" } });
  check("the initiative tier leaves create free", tiered.status, 200);
  const made = await post(base, "/api/initiatives", { body: { title: "Waves of work", description: "The first slice - one lane, one wave, three members." } });
  check("the initiative is created", made.status, 201);
  const initiativeId = made.json?.initiative?.id;
  ok("the initiative has an id", Boolean(initiativeId), String(initiativeId || ""));

  const assistant = (await GET("/api/state")).json?.assistant?.assistants?.[0];
  ok("the panel seeded an assistant", Boolean(assistant?.id), String(assistant?.id || ""));
  const add = async (title, worktree, projectName) => {
    const out = await post(base, "/api/assistant/queue", { body: { assistantId: assistant.id, action: "add", title, worktree, project: projectName } });
    if (out.status !== 200) throw new Error(`filing ${title} answered HTTP ${out.status}: ${out.json?.error || out.text || ""}`);
    const tasks = (await GET(`/api/assistant/queue?assistantId=${assistant.id}`)).json?.queue?.tasks || [];
    const task = tasks.find((t) => t.title === title);
    if (!task) throw new Error(`filed ${title} is not in the queue`);
    return task;
  };
  const setState = async (id, next) => {
    const out = await post(base, "/api/assistant/queue", { body: { assistantId: assistant.id, action: "state", id, state: next } });
    if (out.status !== 200) throw new Error(`setting #${id} ${next} answered HTTP ${out.status}: ${out.json?.error || out.text || ""}`);
  };

  const one = await add("The wave record", treeA, "wave-lane-a");
  const two = await add("The derived state", treeB, "wave-lane-b");
  const three = await add("The lane in the tab", treeA, "wave-lane-a");
  const loose = await add("A task outside the wave", treeB, "wave-lane-b");
  await setState(two.id, "running");
  await setState(three.id, "done");

  // Membership is the task's own field, stamped here exactly as a reader or a later write route would.
  const queueFile = path.join(sandbox, "logs", "assistants", assistant.id, "queue.json");
  const queued = readQueueFile(queueFile);
  if (queued.error) throw new Error(`the queue cannot be read: ${queued.error}`);
  writeQueueFile(
    queueFile,
    queued.tasks.map((t) => (t.id === loose.id ? t : { ...t, waveId: "wave_01" })),
    queued.nextId,
  );

  writeFileSync(
    wavesFile,
    `${JSON.stringify(
      {
        version: 1,
        byInitiative: {
          [initiativeId]: [
            {
              id: "wave_01",
              initiativeId,
              position: 1,
              title: "The read path - record, fold and lane",
              entryGate: { check: "clean" },
              exitGate: { check: "pr-merged" },
              template: "poc-to-uat",
              auto: false,
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // The route's own answer, so the paint is compared with the fold rather than eyeballed.
  const doc = await GET(`/api/waves?initiative=${initiativeId}`);
  check("the wave route answers", doc.status, 200);
  const served = doc.json?.waves?.[0];
  check("the route's member count", served?.members?.length, 3);
  check("the route's wave state", served?.state, "running");
  check("the route's entry gate", served?.gates?.entry?.state, "met");
  check("the route's exit gate", served?.gates?.exit?.state, "unknown");

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the wave lane at two widths", "playwright is not installed for this node (see tools/browser.mjs)"));
    failures += 1;
  } else {
    await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        const shot = async (slug) => {
          if (!shotsDir) return null;
          const file = shotName(slug);
          await page.screenshot({ path: file });
          note(`shot ${path.basename(file)}`);
          return file;
        };
        const shotPane = async (slug) => {
          if (!shotsDir) return null;
          const box = await page.locator("#as-initiatives").boundingBox();
          if (!box) return null;
          const file = shotName(slug);
          await page.screenshot({
            path: file,
            clip: { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: Math.min(1440 - Math.max(0, box.x - 4), box.width + 8), height: Math.min(900 - Math.max(0, box.y - 4), box.height + 8) },
          });
          note(`shot ${path.basename(file)}`);
          return file;
        };

        const shotLane = async (slug) => {
          if (!shotsDir) return null;
          const el = page.locator("#as-initiatives .init-wavefold").first();
          if ((await el.count()) === 0) return null;
          const file = shotName(slug);
          await el.screenshot({ path: file });
          note(`shot ${path.basename(file)}`);
          return file;
        };

        // One read of the geometry the lane must hold to. Every number is the element's own scrollWidth/clientWidth,
        // never a computed guess; `documentWidth` is what the READER would have to scroll sideways.
        const geometry = () =>
          page.evaluate(() => {
            const pane = document.getElementById("as-initiatives");
            const doc = document.scrollingElement || document.documentElement;
            const over = (el) => (el ? el.scrollWidth - el.clientWidth : 0);
            const rows = [...pane.querySelectorAll(".wave-row")];
            const card = pane.querySelector(".init-wavefold")?.closest(".init-card") || pane.querySelector(".init-card");
            const paneRight = pane.getBoundingClientRect().right;
            return {
              documentWidth: doc.scrollWidth,
              documentClient: doc.clientWidth,
              paneOverflow: over(pane),
              cardOverflow: over(card),
              // WHAT STICKS OUT, named: a pane overflow with no element named is a number nobody can act on.
              past: [...pane.querySelectorAll("*")]
                .map((el) => ({ el, r: el.getBoundingClientRect() }))
                .filter(({ r }) => r.right > paneRight + 1)
                .slice(0, 8)
                .map(({ el, r }) => `${el.tagName.toLowerCase()}.${String(el.className || "").split(/\s+/).filter(Boolean).join(".")} +${Math.round(r.right - paneRight)}px`),
              rows: rows.map((r) => ({
                id: r.getAttribute("data-wave-id"),
                overflow: over(r),
                head: over(r.querySelector(".wave-head")),
                gates: over(r.querySelector(".wave-gates")),
                members: over(r.querySelector(".wave-members")),
              })),
              waves: rows.length,
            };
          });

        const painted = () =>
          page.evaluate(() => {
            const row = document.querySelector('#as-initiatives [data-wave-id="wave_01"]');
            if (!row) return null;
            return {
              state: row.getAttribute("data-wave-state"),
              current: row.getAttribute("data-wave-current"),
              pos: row.querySelector(".wave-pos")?.textContent.trim(),
              title: row.querySelector(".wave-title")?.textContent.trim(),
              stateChip: row.querySelector("[data-wave-state-chip]")?.textContent.trim(),
              entry: row.querySelector('[data-wave-gate="entry"]')?.textContent.trim(),
              exit: row.querySelector('[data-wave-gate="exit"]')?.textContent.trim(),
              entryState: row.querySelector('[data-wave-gate="entry"]')?.getAttribute("data-gate-state"),
              exitState: row.querySelector('[data-wave-gate="exit"]')?.getAttribute("data-gate-state"),
              auto: row.querySelector(".wave-auto")?.textContent.trim(),
              template: row.querySelector("[data-wave-template]")?.getAttribute("data-wave-template"),
              templateResolved: row.querySelector("[data-wave-template]")?.getAttribute("data-template-resolved"),
              members: [...row.querySelectorAll("[data-wave-member]")].map((m) => ({
                id: m.getAttribute("data-wave-member"),
                state: m.getAttribute("data-member-state"),
                chip: m.querySelector(".wave-mstate")?.textContent.trim(),
                project: m.querySelector(".wave-member-project")?.textContent.trim(),
              })),
            };
          });

        await openPage(page, base, { selector: "#projects" });
        const open = await page.evaluate(() => {
          const el = document.getElementById("assistant");
          return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
        });
        if (!open) await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
        await page.click('#as-tabs [data-as-tab="initiatives"]');
        await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 30_000 });

        await page.click("#as-initiatives .init-card .init-head-btn");
        await page.waitForSelector("#as-initiatives .init-card .init-wavefold", { timeout: 20_000 });
        await page.waitForSelector('#as-initiatives [data-wave-id="wave_01"] .wave-member', { timeout: 20_000 });

        for (const width of [1440, 768]) {
          console.log(`\n== ${width} ==`);
          await page.setViewportSize({ width, height: 900 });
          await sleep(300);
          // With the card OPEN, then with it FOLDED: the lane's own contribution to the document is the difference,
          // at the same width. A page that is already 768-wide content cannot be blamed on the lane, and a page that
          // grows when the lane paints is.
          const g = await geometry();
          const head = page.locator("#as-initiatives .init-card .init-head-btn").first();
          await head.click();
          await page.waitForSelector("#as-initiatives .init-card .init-wavefold", { state: "detached", timeout: 20_000 }).catch(() => {});
          await sleep(200);
          const closedWidth = await page.evaluate(() => (document.scrollingElement || document.documentElement).scrollWidth);
          await head.click();
          await page.waitForSelector("#as-initiatives .init-card .init-wavefold", { timeout: 20_000 });
          await page.waitForSelector('#as-initiatives [data-wave-id="wave_01"] .wave-member', { timeout: 20_000 });
          await sleep(200);
          note(`document ${g.documentWidth}px wide open, ${closedWidth}px folded; pane overflow ${g.paneOverflow}px; card overflow ${g.cardOverflow}px`);
          if (g.past.length) note(`past the pane's right edge: ${g.past.join(", ")}`);
          for (const r of g.rows) note(`wave ${r.id}: row ${r.overflow}px, head ${r.head}px, gates ${r.gates}px, members ${r.members}px`);
          ok(`at ${width} the document is no wider with the lane open than with it folded`, g.documentWidth <= closedWidth, `${g.documentWidth} vs ${closedWidth}`);
          ok(`at ${width} the pane has no horizontal overflow`, g.paneOverflow <= 0, `${g.paneOverflow}px`);
          ok(`at ${width} the initiative card has no horizontal overflow`, g.cardOverflow <= 0, `${g.cardOverflow}px`);
          ok(
            `at ${width} every wave row, head, gate strip and member strip fits`,
            g.rows.every((r) => r.overflow <= 0 && r.head <= 0 && r.gates <= 0 && r.members <= 0),
            JSON.stringify(g.rows),
          );
          check(`at ${width} the lane is drawn inside an initiative card`, g.waves, 1);

          const p = await painted();
          ok(`at ${width} the wave is in the Initiatives tab and reads running`, p?.state === "running" && p?.stateChip === "running", JSON.stringify(p && { state: p.state, chip: p.stateChip }));
          ok(`at ${width} the wave is marked current`, p?.current === "true", String(p?.current));
          check(`at ${width} the position is drawn`, p?.pos, "W1");
          ok(`at ${width} the entry gate and its live answer are drawn`, p?.entryState === "met" && /- met$/.test(p?.entry || ""), String(p?.entry));
          ok(`at ${width} the exit gate and its live answer are drawn`, p?.exitState === "unknown" && /- cannot tell$/.test(p?.exit || ""), String(p?.exit));
          ok(`at ${width} the auto chip reads off`, p?.auto === "auto off", String(p?.auto));
          ok(`at ${width} the template is drawn and reads unresolved`, p?.template === "poc-to-uat" && p?.templateResolved === "false", `${p?.template} ${p?.templateResolved}`);
          check(
            `at ${width} every member's own state is drawn, queued/running/done`,
            (p?.members || []).map((m) => m.state).sort(),
            ["done", "queued", "running"],
          );
          check(
            `at ${width} the members span two projects`,
            [...new Set((p?.members || []).map((m) => m.project))].sort(),
            ["wave-lane-a", "wave-lane-b"],
          );
          await shotPane(`lane-${width}`);
          await shotLane(`wave-${width}`);
        }

        // The task outside the wave is on the board and is NOT a member: three member chips, never four.
        const looseShown = await page.evaluate((id) => Boolean(document.querySelector(`#as-initiatives [data-wave-member="${id}"]`)), loose.id);
        ok("the task that names no wave is not drawn as a member", looseShown === false);

        console.log("\n== health ==");
        check("no page errors", pageErrors.map(String), []);
        check("no console errors", consoleErrors.map(String), []);
      },
      { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    );
  }
} catch (err) {
  failures += 1;
  console.error(`\nFAIL  the run threw: ${err && err.stack ? err.stack : err}`);
  try {
    console.error(panel.log().split("\n").slice(-20).join("\n"));
  } catch {
    /* the log is a courtesy */
  }
} finally {
  await panel.stop();
  rmSync(sandbox, { recursive: true, force: true });
  clearTimeout(watchdog);
}

console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed${shotsDir ? `; shots in ${shotsDir}` : ""}`);
process.exit(failures === 0 ? 0 : 1);
