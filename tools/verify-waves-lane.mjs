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
//   6. EVERY BAR FILLS ITS SECTION (row 291, ask 1). Each bar's own rectangle against the `.wave-members` strip it
//      sits in: one left inset, right edge flush, the bar as wide as the strip (never as wide as its title), at 1440
//      and at 768. The 760px cap and the inline-flex row this replaced both showed up here as a right gap.
//   7. THE BAR OPENS ITS TASK, IN THE ASSISTANT THAT OWNS IT (ask 2). The sandbox has two assistants, each with a
//      member of the same wave. Pressing the second assistant's bar must put ITS tab and ITS queue on screen with
//      that task's row flashed and scrolled to - and the address it wrote must land there again after a reload.
//   8. THE OWNER CHIP ASKS THAT ASSISTANT, WITH THE SENTENCE TYPED (ask 3). The chip's press must focus the owning
//      assistant's composer with exactly "I have a question about #<id> <title>... " in it, send nothing, and - the
//      choice this row states - keep the sentence as a draft when the reader clicks away, so a repaint draws it back.
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

  // THE ASSISTANT'S RECORD IS SEEDED ON THE BOOT PASS, so a read that lands while that pass is still running answers a
  // state with no assistant in it. Poll for the record rather than reading once and blaming the panel.
  let assistant = null;
  await waitForState(
    base,
    (s) => {
      const first = ((s.assistant || {}).assistants || [])[0];
      if (first?.id) assistant = first;
      return Boolean(first?.id);
    },
    "the panel's first assistant",
    { timeout: 60_000 },
  );
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

  // A SECOND ASSISTANT, because two of the three asks are about WHICH assistant a bar belongs to: a wave whose members
  // all live in one queue can never catch a press that lands in the wrong one. Its task is a member of the same wave.
  const createTwo = await post(base, "/api/assistant/assistants", { body: { name: "Assistant #2" } });
  check("a second assistant is created", createTwo.status, 201);
  let twoRec = null;
  await waitForState(
    base,
    (s) => {
      const rec = ((s.assistant || {}).assistants || []).find((a) => a.id === "assistant-2");
      if (rec?.threadId) twoRec = rec;
      return Boolean(rec?.threadId);
    },
    "the second assistant to reach the state read",
    { timeout: 60_000 },
  );
  ok("the second assistant has an id and a thread of its own", Boolean(twoRec?.id && twoRec?.threadId), `${twoRec?.id} ${twoRec?.threadId}`);
  const addTwo = await post(base, "/api/assistant/queue", { body: { assistantId: twoRec.id, action: "add", title: "The owner's own row", worktree: treeB, project: "wave-lane-b" } });
  check("the second assistant's queue takes a task", addTwo.status, 200);
  const owned = ((await GET(`/api/assistant/queue?assistantId=${twoRec.id}`)).json?.queue?.tasks || []).find((t) => t.title === "The owner's own row");
  ok("the second assistant's task has an id", Boolean(owned?.id), String(owned?.id || ""));
  const ownedQueueFile = path.join(sandbox, "logs", "assistants", twoRec.id, "queue.json");
  const ownedQueued = readQueueFile(ownedQueueFile);
  if (ownedQueued.error) throw new Error(`the second queue cannot be read: ${ownedQueued.error}`);
  writeQueueFile(
    ownedQueueFile,
    ownedQueued.tasks.map((t) => (t.id === owned.id ? { ...t, waveId: "wave_01" } : t)),
    ownedQueued.nextId,
  );

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
  check("the route's member count", served?.members?.length, 4);
  check("the route's wave state", served?.state, "running");
  check("the route's entry gate", served?.gates?.entry?.state, "met");
  check("the route's exit gate", served?.gates?.exit?.state, "unknown");
  // A member carries the assistant its queue belongs to, and the role label the worktree column's chip draws: without
  // it a bar could name the wrong queue (every assistant numbers its tasks from one).
  const servedOwned = (served?.members || []).find((m) => m.id === owned.id && m.assistantId === twoRec.id);
  check("the route's member names its owning assistant", servedOwned?.assistantId, twoRec.id);
  ok("the owner's name and role label travel with the member", Boolean(servedOwned?.assistantName && servedOwned?.assistantLabel), `${servedOwned?.assistantName} / ${servedOwned?.assistantLabel}`);
  check(
    "each member names the assistant its own queue belongs to",
    [...new Set((served?.members || []).map((m) => m.assistantId))].sort(),
    [assistant.id, twoRec.id],
  );
  // The worktree column's tag rule, repeated here for the EXPECTATION only: the page's copy is
  // public/core/waves-lane.js `ownerTagOf`, and public/app.js `ownerTagOf` is the one it mirrors.
  const tagOf = (label) => {
    const source = String(label || "").trim();
    const m = /^(.*?)[\s#]*(\d+)\s*$/.exec(source);
    const words = String(m ? m[1] : source)
      .split(/[\s/-]+/)
      .filter(Boolean);
    return `${words.map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "A"}${m ? m[2] : ""}`;
  };
  const tagFor = (id) => {
    const m = (served?.members || []).find((x) => x.assistantId === id);
    return tagOf(m?.assistantLabel || m?.assistantName || id);
  };
  // EVERY ASSISTANT NUMBERS ITS OWN QUEUE FROM ONE, so the sandbox's two tasks are BOTH #1: a bar is selected by the
  // task's id AND its owner, which is the fact this row exists for.
  const ownedBar = `#as-initiatives [data-wave-member="${owned.id}"][data-member-owner="${twoRec.id}"]`;

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
              // EVERY BAR AGAINST ITS SECTION (row 291, ask 1): the strip is the section's content box, so the
              // claim "same left inset, right edge flush" is each bar's own rectangle against it - rounded to whole
              // pixels, because a fractional layout can leave half a pixel and nothing a reader can see.
              bars: [...pane.querySelectorAll(".wave-member")].map((el) => {
                const strip = el.closest(".wave-members");
                const r = el.getBoundingClientRect();
                const s = strip.getBoundingClientRect();
                const title = el.querySelector(".wave-member-title");
                return {
                  id: el.getAttribute("data-wave-member"),
                  left: Math.round(r.left - s.left),
                  right: Math.round(s.right - r.right),
                  width: Math.round(r.width),
                  strip: Math.round(s.width),
                  titleWraps: title ? title.scrollWidth <= title.clientWidth + 1 : null,
                  titleRows: title ? Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight || "16")) : null,
                };
              }),
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
                owner: m.getAttribute("data-member-owner"),
                ownerTag: m.querySelector("[data-wave-owner]")?.textContent.trim(),
                open: m.getAttribute("data-wave-open"),
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
          // ASK 1, MEASURED: every bar in the wave fills the section. Left inset the same for all of them, right edge
          // on the section's own right edge, and a bar that is not just as wide as its title - the screenshot's defect
          // was bars ending where their words did, and a cap at 760px is the same defect with a different number.
          ok(
            `at ${width} every task bar fills its section: one left inset, right edge flush`,
            g.bars.length >= 4 && g.bars.every((b) => b.left >= -1 && b.left <= 1 && b.right >= -1 && b.right <= 1),
            JSON.stringify(g.bars.map((b) => ({ id: b.id, left: b.left, right: b.right, width: b.width, strip: b.strip }))),
          );
          ok(
            `at ${width} every task bar is the section's width, not its text's`,
            g.bars.every((b) => b.width >= b.strip - 2),
            JSON.stringify(g.bars.map((b) => ({ id: b.id, width: b.width, strip: b.strip }))),
          );
          ok(
            `at ${width} a long title wraps inside the bar instead of widening it`,
            g.bars.every((b) => b.titleWraps !== false),
            JSON.stringify(g.bars.map((b) => ({ id: b.id, wraps: b.titleWraps, rows: b.titleRows }))),
          );

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
            ["done", "queued", "queued", "running"],
          );
          check(
            `at ${width} the members span two projects`,
            [...new Set((p?.members || []).map((m) => m.project))].sort(),
            ["wave-lane-a", "wave-lane-b"],
          );
          // The tag is the worktree column's own rule; these two assistants run the Manager role in the sandbox, so the
          // chips read M1 and M2 - and the expectation is derived from the labels the route served, not hard-coded.
          check(
            `at ${width} every member names its owner and draws the owner chip`,
            (p?.members || []).map((m) => `${m.owner}>${m.ownerTag}`).sort(),
            [assistant.id, assistant.id, assistant.id, twoRec.id].map((id) => `${id}>${tagFor(id)}`).sort(),
          );
          await shotPane(`lane-${width}`);
          await shotLane(`wave-${width}`);
        }

        // ---- the wide float: the same lane in the panel's floating frame, at a width where the member row is the
        // GRID drawing (public/style.css `@container (min-width: 900px)`). The dock above never reaches that query, so
        // without this pass the six-column row would be shipped unmeasured.
        console.log("\n== the wide float ==");
        const frame = await post(base, "/api/settings/general", { body: { dockMode: "floating" } });
        check("the panel's frame is switched to the float", frame.status, 200);
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.evaluate(() => localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 40, y: 60, w: 1240, h: 840 })));
        await page.goto(base);
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 30_000 });
        await page.evaluate(() => document.querySelector('#as-tabs [data-as-tab="initiatives"]').click());
        await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 30_000 });
        if ((await page.locator("#as-initiatives .init-wavefold").count()) === 0) {
          await page.click("#as-initiatives .init-card .init-head-btn");
          await page.waitForSelector("#as-initiatives .init-wavefold", { timeout: 20_000 });
        }
        await page.waitForSelector(`#as-initiatives [data-wave-member="${owned.id}"]`, { timeout: 20_000 });
        await sleep(400);
        const wide = await page.evaluate(() => {
          const pane = document.getElementById("as-initiatives");
          const card = pane.querySelector(".init-wavefold")?.closest(".init-card") || pane.querySelector(".init-card");
          const el = document.getElementById("assistant");
          const fr = el.getBoundingClientRect();
          const members = [...pane.querySelectorAll(".wave-member")];
          return {
            floating: el.classList.contains("is-floating"),
            floatW: Math.round(fr.width),
            paneW: Math.round(pane.getBoundingClientRect().width),
            paneOverflow: pane.scrollWidth - pane.clientWidth,
            cardOverflow: card ? card.scrollWidth - card.clientWidth : null,
            display: members.length ? getComputedStyle(members[0]).display : null,
            bars: members.map((m) => {
              const s = m.closest(".wave-members").getBoundingClientRect();
              const r = m.getBoundingClientRect();
              return { left: Math.round(r.left - s.left), right: Math.round(s.right - r.right), width: Math.round(r.width), strip: Math.round(s.width) };
            }),
          };
        });
        note(`float ${wide.floatW}px wide, the pane ${wide.paneW}px, member rows drawn as ${wide.display}; pane overflow ${wide.paneOverflow}px, card overflow ${wide.cardOverflow}px`);
        ok("the frame is the floating one, and it is wider than the 900px the member grid needs", wide.floating && wide.floatW > 900, JSON.stringify({ floating: wide.floating, floatW: wide.floatW }));
        ok("at the wide float the member row is the grid drawing", wide.display === "grid", String(wide.display));
        ok(
          "at the wide float every task bar still fills its section: one left inset, right edge flush",
          wide.bars.length >= 4 && wide.bars.every((b) => b.left >= -1 && b.left <= 1 && b.right >= -1 && b.right <= 1 && b.width >= b.strip - 2),
          JSON.stringify(wide.bars),
        );
        ok("at the wide float neither the card nor the pane scrolls sideways", wide.paneOverflow <= 0 && wide.cardOverflow <= 0, `${wide.paneOverflow} / ${wide.cardOverflow}`);
        await shotPane("lane-wide-float");
        await shotLane("wave-wide-float");

        // Back to the dock for the press proofs below: the wide float is its own pass and the presses are one path.
        await post(base, "/api/settings/general", { body: { dockMode: "docked" } });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(base);
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 30_000 });
        await page.evaluate(() => document.querySelector('#as-tabs [data-as-tab="initiatives"]').click());
        await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 30_000 });
        if ((await page.locator("#as-initiatives .init-wavefold").count()) === 0) {
          await page.click("#as-initiatives .init-card .init-head-btn");
          await page.waitForSelector("#as-initiatives .init-wavefold", { timeout: 20_000 });
        }
        await page.waitForSelector(`#as-initiatives [data-wave-member="${owned.id}"]`, { timeout: 20_000 });

        // The task outside the wave is on the board and is NOT a member: three member chips, never four.
        const looseShown = await page.evaluate((id) => [...document.querySelectorAll(`#as-initiatives [data-wave-member="${id}"]`)].some((m) => m.getAttribute("data-member-owner") === "assistant-1"), loose.id);
        ok("the task that names no wave is not drawn as a member", looseShown === false);

        // =============================================================================================================
        console.log("\n== ask 2: the bar opens its task, in the assistant that owns it ==");
        await page.setViewportSize({ width: 1440, height: 900 });
        await sleep(250);
        await page.evaluate(() => document.querySelector('#as-tabs [data-as-tab="initiatives"]').click());
        await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
        if ((await page.locator("#as-initiatives .init-wavefold").count()) === 0) {
          await page.click("#as-initiatives .init-card .init-head-btn");
          await page.waitForSelector("#as-initiatives .init-wavefold", { timeout: 20_000 });
        }
        await page.waitForSelector(ownedBar, { timeout: 20_000 });
        await shotLane("bar-before-press");

        // A press on the bar's own id cell: inside the bar, on nothing that has a press of its own.
        // The pulse is a CLASS the queue adds and takes away, so it is WATCHED rather than sampled: a MutationObserver
        // records it even if a repaint replaces the row a moment later.
        await page.evaluate((id) => {
          window.__sawFlash = false;
          const host = document.getElementById("as-queue-2") || document.body;
          window.__flashObs = new MutationObserver(() => {
            if (document.querySelector(`#as-queue-2 .as-task[data-as-qrow="${id}"].flash`)) window.__sawFlash = true;
          });
          window.__flashObs.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
        }, owned.id);
        await page.click(`${ownedBar} .wave-member-id`);
        await page.waitForSelector("#as-queue-2:not(.hidden)", { timeout: 20_000 });
        await page.waitForSelector(`#as-queue-2 .as-task[data-as-qrow="${owned.id}"]`, { timeout: 20_000 });
        await sleep(900);
        const sawFlash = await page.evaluate((id) => {
          const seen = Boolean(window.__sawFlash);
          window.__flashObs?.disconnect();
          const row = document.querySelector(`#as-queue-2 .as-task[data-as-qrow="${id}"]`);
          return { seen, live: Boolean(row && row.classList.contains("flash")) };
        }, owned.id);
        const onQueue = await page.evaluate(
          (id) => {
            const tab = document.querySelector('#as-tabs [data-as-tab="assistant-2"]');
            const pane = document.getElementById("as-queue-2");
            const row = pane?.querySelector(`.as-task[data-as-qrow="${id}"]`);
            const pr = pane?.getBoundingClientRect();
            const rr = row?.getBoundingClientRect();
            return {
              tabOn: Boolean(tab && tab.classList.contains("is-on")),
              queueShown: Boolean(pane && !pane.classList.contains("hidden")),
              row: Boolean(row),
              flash: Boolean(row && row.classList.contains("flash")),
              onScreen: Boolean(pr && rr && rr.top >= pr.top - 1 && rr.bottom <= pr.bottom + 1),
              hash: location.hash,
            };
          },
          owned.id,
        );
        ok("the press puts Assistant #2's tab on screen", onQueue.tabOn, String(onQueue.tabOn));
        ok("the press opens that assistant's Queue", onQueue.queueShown, String(onQueue.queueShown));
        ok("the press lands on the task's OWN row, in Assistant #2's list", onQueue.row, String(onQueue.row));
        ok("the landed row is highlighted (the queue's own flash was seen)", sawFlash.seen, `${JSON.stringify(sawFlash)} live-class-in-snapshot ${onQueue.flash}`);
        ok("the landed row is scrolled into the queue's view", onQueue.onScreen, String(onQueue.onScreen));
        check("the press writes the task into the address", onQueue.hash, `#task=assistant-2/${owned.id}`);
        await shot("bar-press-landed");

        // ...AND IT SURVIVES A RELOAD. Load the address a second time from scratch: no press, no view state to lean on.
        console.log("\n== ask 2: the same task after a reload ==");
        await page.goto(`${base}/#task=assistant-2/${owned.id}`);
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 30_000 });
        await page.waitForSelector("#as-queue-2:not(.hidden)", { timeout: 30_000 });
        await page.waitForSelector(`#as-queue-2 .as-task[data-as-qrow="${owned.id}"]`, { timeout: 30_000 });
        const reloaded = await page.evaluate(
          (id) => {
            const pane = document.getElementById("as-queue-2");
            const row = pane?.querySelector(`.as-task[data-as-qrow="${id}"]`);
            const pr = pane?.getBoundingClientRect();
            const rr = row?.getBoundingClientRect();
            return {
              tabOn: document.querySelector('#as-tabs [data-as-tab="assistant-2"]')?.classList.contains("is-on"),
              row: Boolean(row),
              onScreen: Boolean(pr && rr && rr.top >= pr.top - 1 && rr.bottom <= pr.bottom + 1),
              hash: location.hash,
            };
          },
          owned.id,
        );
        ok("a reload of the address opens Assistant #2's tab again", reloaded.tabOn, String(reloaded.tabOn));
        ok("a reload lands on the same task", reloaded.row, String(reloaded.row));
        ok("a reload leaves the task scrolled into its queue", reloaded.onScreen, String(reloaded.onScreen));
        check("the address survives the reload unchanged", reloaded.hash, `#task=assistant-2/${owned.id}`);

        // =============================================================================================================
        console.log("\n== ask 3: the owner chip asks that assistant, with the sentence already typed ==");
        // ONE TURN ON ASSISTANT #2'S THREAD, PUT IN THE PAGE'S OWN JOB VIEW (a page-side fixture, not a panel record):
        // an assistant with a conversation types into its thread's reply box, and that is the composer whose draft
        // contract the prefill has to keep. Nothing is started and no gateway is reached (the sandbox points at a
        // dead port, so a send would fail loudly rather than quietly).
        await page.evaluate((thread) => {
          const id = "sandbox-fixture-turn";
          if (!state.jobs.has(id)) {
            state.jobs.set(id, {
              id,
              thread,
              turn: 1,
              status: "done",
              prompt: "a fixture turn, so this thread has a reply box",
              startedAt: new Date(Date.now() - 60_000).toISOString(),
              endedAt: new Date(Date.now() - 50_000).toISOString(),
              lines: [{ kind: "say", text: "done", at: Date.now() - 55_000 }],
            });
          }
          window.__assistantRenderChat(thread);
        }, twoRec.threadId);
        await page.click('#as-tabs [data-as-tab="initiatives"]');
        await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
        if ((await page.locator("#as-initiatives .init-wavefold").count()) === 0) {
          await page.click("#as-initiatives .init-card .init-head-btn");
          await page.waitForSelector("#as-initiatives .init-wavefold", { timeout: 20_000 });
        }
        await page.waitForSelector(`${ownedBar} [data-wave-owner]`, { timeout: 20_000 });
        // THE COMPOSER IS CLOSED BEFORE THE PRESS: the reader is on the Initiatives tab, so that assistant's Chat - and
        // the box the chip has to put the caret in - is not on screen. The press is what opens it.
        const beforeChip = await page.evaluate(() => ({
          chat: !document.getElementById("as-chat-2")?.classList.contains("hidden"),
          queue: !document.getElementById("as-queue-2")?.classList.contains("hidden"),
        }));
        ok("the chip is pressed while that assistant's composer is not on screen", !beforeChip.chat, JSON.stringify(beforeChip));
        await page.click(`${ownedBar} [data-wave-owner]`);
        await page.waitForSelector("#as-chat-2:not(.hidden)", { timeout: 20_000 });
        await sleep(300);
        const prefillText = `I have a question about #${owned.id} The owner's own row... `;
        const asked = await page.evaluate(
          (thread) => {
            const box = document.querySelector(`#as-chat-2 .reply-box[data-reply="${thread}"]`) || document.getElementById("as-first-text-2");
            const read = box ? String(box.value !== undefined ? box.value : box.innerText).replace(/\u00a0/g, " ") : null;
            return {
              tabOn: document.querySelector('#as-tabs [data-as-tab="assistant-2"]')?.classList.contains("is-on"),
              chatShown: !document.getElementById("as-chat-2")?.classList.contains("hidden"),
              focused: Boolean(box) && document.activeElement === box,
              text: read,
              box: box ? String(box.dataset.chipbox || "") : null,
              jobs: document.querySelectorAll("#as-chat-2 .job").length,
            };
          },
          twoRec.threadId,
        );
        ok("the chip puts Assistant #2's Chat on screen", asked.tabOn && asked.chatShown, JSON.stringify({ tabOn: asked.tabOn, chatShown: asked.chatShown }));
        ok("the chip focuses that assistant's composer", asked.focused, String(asked.focused));
        check("the composer holds exactly the question, caret ready at the end", asked.text, prefillText);
        ok("the prefill is in the THREAD's own reply box", asked.box === `reply:${twoRec.threadId}`, String(asked.box));
        await shot("chip-prefill");

        // NOTHING IS SENT BY ITSELF: the box still holds the sentence, and the thread has the one fixture turn it had.
        await sleep(1200);
        const stillUnsent = await page.evaluate(
          (thread) => {
            const box = document.querySelector(`#as-chat-2 .reply-box[data-reply="${thread}"]`);
            return {
              jobs: document.querySelectorAll("#as-chat-2 .job").length,
              warn: document.querySelector(`#as-chat-2 .reply [data-reply-warn]`)?.textContent.trim() || "",
              text: box ? String(box.innerText).replace(/\u00a0/g, " ") : null,
            };
          },
          twoRec.threadId,
        );
        check("a chip press never becomes a sent message", stillUnsent.jobs, asked.jobs);
        check("nothing was posted, so the composer's warning line is still empty", stillUnsent.warn, "");
        check("the sentence is still in the box, unsent", stillUnsent.text, prefillText);

        // THE PREFILL IS KEPT AS A DRAFT (the choice this row states): it is in the composer's own draft map, so the
        // card's next repaint - the kind a live turn causes every few seconds - draws the words back. The reader
        // clicking away first is what makes this a draft test rather than a focused-box test.
        await page.evaluate(() => (document.activeElement && document.activeElement.blur ? document.activeElement.blur() : null));
        await page.evaluate((thread) => {
          const j = [...state.jobs.values()].find((x) => (x.thread || x.id) === thread);
          if (j) j.lines = [...(j.lines || []), { kind: "say", text: "a later line, so the card is rebuilt", at: Date.now() }];
          window.__assistantRenderChat(thread);
        }, twoRec.threadId);
        await sleep(300);
        const afterRepaint = await page.evaluate((thread) => {
          const boxes = [...document.querySelectorAll(`#as-chat-2 .reply-box[data-reply="${thread}"]`)];
          const box = boxes[boxes.length - 1];
          return { text: box ? String(box.innerText).replace(/\u00a0/g, " ") : null, boxes: boxes.length };
        }, twoRec.threadId);
        check("an abandoned prefill is kept as a draft, and a repaint draws it back", afterRepaint.text, prefillText);

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
