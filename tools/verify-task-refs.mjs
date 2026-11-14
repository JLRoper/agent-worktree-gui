#!/usr/bin/env node
// HARNESS: LIVE GATE
// Two presses that turn a word on the page into a place: a task id in the assistant's transcript, and the owner chip in
// the worktree chart.
//
//   node tools/verify-task-refs.mjs [--shots <dir>]
//
// WHAT THIS GUARDS. Both features are only real in a browser: one is an anchor whose press has to move the float, scroll
// a pane and start an animation; the other is a chip whose press has to land a caret in a contenteditable. Neither can be
// proved by slicing a renderer's string, so this boots a real panel, seeds a real queue and a real turn, and drives
// Chromium at 1440x900. In order:
//
//   1. RENDER TIME. `#405` in the transcript is an <a> with data-as-task="405" and data-as-task-own="assistant-1", built
//      by the renderer (public/core/console-markdown.js) - it is in the markup the card was painted from, not added to
//      the DOM afterwards. `PR #760` in the same sentence is NOT an anchor, and neither is a `#` inside a code span.
//   2. ONE PRESS. Pressing the anchor puts Assistant #1's QUEUE on screen, widens the pane's window to a row the pane had
//      not drawn (405 sits 26th of 30), centres that row in the pane's own scroller, and starts the chart's green pulse
//      on it - which fades on its own. Nothing is sent.
//   3. THE CHIP. The owner cell of a row owned by Assistant #2 is a <button> carrying the row's project, worktree and
//      branch. Pressing it opens Assistant #2's CHAT with "Regarding <project> <worktree> <branch>: " in the box, the
//      caret at the end, the box focused - and nothing posted.
//   4. KEPT WORKING. On the same page: the chart's two edges are still the same 1px rule (PR 760), and the console card
//      still folds on one press of its head (PR 758) - the deeper numbers for both live in verify-chart-edges.mjs and
//      verify-turn-fold.mjs, which this run also reports.
//
// Sandbox only: a throwaway repo with one hand-cut worktree, its own HERMES_HOME, PANEL_CONFIG, logs, locks store, jobs
// file and port, and an apiServer pointed at a dead port. The live panel on 7331 and the live gateway are never touched.
// Without a Playwright install it says BROWSER-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, withBrowser } from "./browser.mjs";
import { ROOT, freePort, git, startPanel, waitFor } from "./panel-testkit.mjs";

let failures = 0;
let checks = 0;
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);
const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(tmpdir(), "wtgui-task-refs-shots");
const TASK = 405;
const TASKS = 30;
const TAG = "ab12cd";
const BRANCH = "work/owner-chip";
const gitEnv = { GIT_TERMINAL_PROMPT: "0" };

const playwright = loadPlaywright();
if (!playwright) {
  notRun("the bridge between a word and a place", "no Playwright install; set PANEL_PLAYWRIGHT_ROOT to a dir holding node_modules/playwright");
  process.exit(2);
}

// ---- the sandbox: a real repo, one real worktree, and a state store that says Assistant #2 owns it -----------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-task-refs-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
mkdirSync(shotsDir, { recursive: true });
note(`temp root ${dir.replace(/\\/g, "/")}`);
const repos = path.join(dir, "repos");
const repo = path.join(repos, "task-refs-repo");
const treeName = `owner-chip-${TAG}`;
const tree = path.join(repo, ".worktrees", treeName);
mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# task refs\n", "utf8");
git(repo, ["add", "-A"]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "seed the sandbox repo"], { env: gitEnv });
git(repo, ["worktree", "add", "-q", "-b", BRANCH, tree]);
writeFileSync(path.join(tree, "work.txt"), "sandbox work\n", "utf8");
git(tree, ["add", "-A"]);
git(tree, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "do the work"], { env: gitEnv });

// The owner store, keyed the way the server keys it: the project name and the tree's own six-hex tag.
const locksFile = path.join(dir, "logs", "locks.json");
writeFileSync(locksFile, JSON.stringify({ version: 1, owners: { [`task-refs-repo::${TAG}`]: "assistant-2" } }, null, 1), "utf8");

// One settled turn in Assistant #1's own thread, whose prose carries the two references the gate is about.
const TRANSCRIPT = "The anchor for #405 is ready, and `#406` stays code. PR #760 is a pull request, not a task.";
const now = Date.now();
const jobsFile = path.join(dir, "logs", "jobs.json");
writeFileSync(
  jobsFile,
  JSON.stringify(
    {
      savedAt: new Date(now).toISOString(),
      jobs: [
        {
          id: "taskrefs1",
          thread: "panel-assistant",
          turn: 1,
          prompt: "land the two presses",
          status: "done",
          exitCode: 0,
          startedAt: new Date(now - 60_000).toISOString(),
          endedAt: new Date(now - 30_000).toISOString(),
          durationMs: 30_000,
          finalMessage: TRANSCRIPT,
          cwd: tree.replace(/\\/g, "/"),
          ownerPath: tree.replace(/\\/g, "/"),
          worktreePath: tree.replace(/\\/g, "/"),
          worktree: treeName,
          lines: [{ kind: "text", text: TRANSCRIPT, lid: 1, at: now - 31_000 }],
        },
      ],
    },
    null,
    1,
  ),
  "utf8",
);

// The queue: thirty rows, and the id the transcript names sits fifteen rows into the drawn order - inside the simplest
// case (a row the pane has not drawn yet) and far enough down that reaching it means scrolling, not just existing.
const QUEUE = Array.from({ length: TASKS }, (_, i) => {
  const id = 430 - i;
  return {
    id,
    title: `row ${id}`,
    state: "queued",
    files: [],
    agents: [],
    notes: [],
    detail: "",
    order: id === TASK ? 415 : id,
  };
});

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  config: {
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    scanMode: "all",
    defaultCwd: repo,
    locksFile,
    jobsFile,
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});

const GET = async (p) => {
  const r = await fetch(`${panel.base}${p}`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const POST = async (p, body = {}) => {
  const r = await fetch(`${panel.base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const shot = async (page, name) => {
  const file = path.join(shotsDir, name);
  await page.screenshot({ path: file, fullPage: false });
  return file.replace(/\\/g, "/");
};

try {
  // ---- the sandbox says what the gate assumes ---------------------------------------------------------------
  console.log("\n== the sandbox ==");
  const assistants = await GET("/api/assistant");
  const primaryThread = String(assistants.body?.thread || "");
  const first = (assistants.body?.assistants || []).find((a) => a.id === "assistant-1");
  check(Boolean(first), "Assistant #1 is on the board", first ? `thread ${first.threadId}` : "no record");
  check(primaryThread === "panel-assistant", "the seeded turn is filed under Assistant #1's thread", primaryThread);
  const made = await POST("/api/assistant/assistants", {});
  check(made.status === 201, "Assistant #2 exists, so the chip has a second owner to name", `HTTP ${made.status}`);
  const queueFile = (await GET("/api/assistant/queue?assistantId=assistant-1")).body?.queue?.file;
  check(Boolean(queueFile), "the queue route names the file it reads", String(queueFile || "").replace(/\\/g, "/"));
  writeFileSync(queueFile, JSON.stringify({ version: 1, nextId: 500, tasks: QUEUE }, null, 1), "utf8");
  const seeded = (await GET("/api/assistant/queue?assistantId=assistant-1")).body?.queue;
  check(seeded?.counts?.total === TASKS, `the queue reads back ${TASKS} rows`, JSON.stringify(seeded?.counts || {}));
  // Discovery is a scan, not a boot step: the row is there once the registry has probed the repo, so this is polled.
  const rowOf = async () => {
    const board = await GET("/api/state");
    const rows = (board.body?.projects || []).flatMap((p) => (p.worktrees || []).map((w) => ({ project: p.name, ...w })));
    return rows.find((r) => String(r.path || "").replace(/\\/g, "/").endsWith(treeName)) || null;
  };
  const row = await waitFor(rowOf, { timeoutMs: 30_000, stepMs: 250, what: "the sandbox row" });
  check(Boolean(row), "the board draws the sandbox worktree", row ? `${row.project} ${row.name}` : "row not found");
  check(row?.assistant?.id === "assistant-2", "and the owner store names Assistant #2 for it", JSON.stringify(row?.assistant || null));

  await withBrowser(
    async ({ page }) => {
    const posted = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posted.push(r.url());
    });
    await page.goto(panel.base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("section.project", { timeout: 60_000 });
    // A project card boots folded, so the chart's rows are not on the page until its head is pressed - the same step
    // tools/verify-chart-edges.mjs takes before it measures anything. The card is painted after its scan, so this
    // presses until nothing is left folded rather than pressing the heads that exist on the first frame.
    const expand = async () => {
      for (let pass = 0; pass < 60; pass += 1) {
        if (await page.locator("tr.row").count()) return true;
        const heads = await page.locator("section.project.collapsed .project-head[data-toggle-project]").all();
        for (const head of heads) await head.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(250);
      }
      return false;
    };
    check(Boolean(await expand()), "the project card opens");
    await page.waitForSelector("tr.row", { state: "visible", timeout: 20_000 }).catch(async (err) => {
      const dump = await page.evaluate(() => {
        const out = [];
        for (const sec of document.querySelectorAll("section.project")) {
          const table = sec.querySelector("table");
          const trs = [...(table?.tBodies?.[0]?.rows || [])];
          out.push({ secClass: sec.className, h2: (sec.querySelector("h2")?.textContent || "").trim(), tbodyRows: trs.length, text: (sec.textContent || "").replace(/\s+/g, " ").slice(0, 160) });
        }
        return { sections: out, trRow: document.querySelectorAll("tr.row").length };
      });
      console.log("      DIAGNOSTIC", JSON.stringify(dump));
      throw err;
    });
    check((await page.evaluate(() => innerWidth)) === 1440 && (await page.evaluate(() => innerHeight)) === 900, "the window is 1440x900");

    // ---- 1. the anchors, in the markup the card was painted from ------------------------------------------
    console.log("\n== 1. a task id is an anchor at render time ==");
    await page.click("#btn-assistant");
    await page.waitForSelector("#assistant", { state: "visible" });
    await page.waitForSelector('#as-subtabs [data-as-subtab="chat"]', { state: "visible" });
    await page.click('#as-subtabs [data-as-subtab="chat"]');
    const link = '#as-chat a.as-task-ref[data-as-task="405"]';
    // What the page thinks, before the wait blames the paint: the resolver, its answer for 405, and whether the index
    // has answered at all.
    const probe = await page.evaluate(async () => {
      const fn = window.__assistantTaskLink;
      const before = typeof fn === "function" ? fn("405") : "no resolver";
      const rev0 = window.__assistantTaskRev;
      let queues = null;
      try {
        const r = await fetch("/api/assistant/queue");
        const b = await r.json();
        queues = (b.queues || []).map((q) => ({ id: q.assistantId, tasks: (q.tasks || []).length, has405: (q.tasks || []).some((t) => String(t.id) === "405") }));
      } catch (err) {
        queues = String(err);
      }
      await new Promise((r) => setTimeout(r, 1200));
      return { resolver: typeof fn, before, after: typeof fn === "function" ? fn("405") : null, rev0, rev1: window.__assistantTaskRev, queues, chat: (document.querySelector("#as-chat")?.textContent || "").slice(0, 120) };
    });
    note(`probe ${JSON.stringify(probe)}`);
    const drew = await waitFor(() => page.locator(link).count().then((n) => n === 1), { timeoutMs: 25_000, stepMs: 200, what: "the #405 anchor" });
    check(drew, "the transcript draws #405 as one anchor");
    const anchor = await page.evaluate((sel) => {
      const a = document.querySelector(sel);
      if (!a) return null;
      return {
        text: a.textContent.trim(),
        own: a.getAttribute("data-as-task-own"),
        task: a.getAttribute("data-as-task"),
        href: a.getAttribute("href"),
        inConsole: Boolean(a.closest(".conversation, .job, #as-chat")),
        // "Built at render time" is only observable as: it is a node of the painted card, and the card's own painter
        // writes it - the card was not swept afterwards. The signature is that the node existed at the first paint,
        // which the card's own `data-sig` and this anchor sharing a paint can show.
        sig: a.closest(".job")?.dataset.sig || null,
      };
    }, link);
    check(anchor?.text === "#405", "it still reads as the id", anchor?.text);
    check(anchor?.task === "405" && anchor?.own === "assistant-1", "it carries the assistant and the id", JSON.stringify({ task: anchor?.task, own: anchor?.own }));
    check(anchor?.inConsole === true, "it sits in the assistant's own transcript");
    check(!(await page.locator('#as-chat a.as-task-ref[data-as-task="760"]').count()), "PR #760 is not an anchor");
    const codeHits = await page.locator('#as-chat a.as-task-ref[data-as-task="406"]').count();
    check(codeHits === 0, "and a # inside a code span stays code");
    note(`shot ${await shot(page, "1-anchor-in-the-transcript.png")}`);

    // ---- 2. one press: the queue, the row, the pulse -----------------------------------------------------
    console.log("\n== 2. the press lands on the row ==");
    const before = await page.evaluate(() => ({
      rows: document.querySelectorAll('#as-queue .as-task').length,
      subtab: document.querySelector('#as-subtabs [data-as-subtab].is-on')?.dataset?.asSubtab || null,
    }));
    // The pulse is a class that lives for one flash and can be gone before the next round-trip, so it is OBSERVED
    // rather than sampled: the observer is armed before the press and records the class arriving on any row.
    await page.evaluate(() => {
      window.__pulses = [];
      const seen = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "attributes" && m.target.classList?.contains("flash")) window.__pulses.push(m.target.dataset.asQrow || "?");
          for (const n of m.addedNodes || []) if (n.nodeType === 1 && n.classList?.contains("flash")) window.__pulses.push(n.dataset?.asQrow || "?");
        }
      });
      const host = document.querySelector("#as-queue");
      if (host) seen.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
      window.__pulseObs = seen;
    });
    await page.click(link);
    const switched = await waitFor(      () => page.evaluate(() => Boolean(document.querySelector('#as-subtabs [data-as-subtab="queue"]')?.classList.contains("is-on"))),
      { timeoutMs: 10_000, stepMs: 100, what: "the queue sub-tab" },
    );
    check(Boolean(switched), "the press switched the float to that assistant's Queue", `was ${before.subtab}`);
    const flashRow = `#as-queue .as-task[data-as-qrow="${TASK}"]`;
    const arrived = await waitFor(() => page.locator(flashRow).count().then((n) => n === 1), { timeoutMs: 10_000, stepMs: 100, what: "row 405 in the pane" });
    check(arrived, "row 405 is in the pane");
    // The pulse was recorded by the observer above, whatever happened to the node afterwards.
    const pulses = await waitFor(
      () => page.evaluate(() => (window.__pulses || []).length > 0 ? window.__pulses : false),
      { timeoutMs: 6000, stepMs: 80, what: "the pulse" },
    );
    check(Array.isArray(pulses) && pulses.includes(String(TASK)), "the chart's green pulse was started on row 405", JSON.stringify(pulses));
    const after = await page.evaluate((sel) => {
      const row = document.querySelector(sel);
      const pane = row?.closest('[data-subpane="queue"]');
      // The pane's scroller, found the way the page finds it: walk up from the row looking for an overflow box that is
      // taller than its viewport. Anything else is a different element that happens to scroll.
      let scroller = null;
      for (let n = pane; n && n !== document.body; n = n.parentElement) {
        if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
        if (n.scrollHeight <= n.clientHeight + 1) continue;
        scroller = n;
        break;
      }
      if (!scroller && document.scrollingElement?.scrollHeight > document.scrollingElement.clientHeight + 1) scroller = document.scrollingElement;
      const r = row?.getBoundingClientRect();
      const s = scroller?.getBoundingClientRect();
      return {
        rows: document.querySelectorAll("#as-queue .as-task").length,
        flash: row?.classList.contains("flash") || false,
        centred: r && s ? Math.round(r.top + r.height / 2 - (s.top + s.height / 2)) : null,
        inView: r && s ? r.top >= s.top - 2 && r.bottom <= s.bottom + 2 : null,
        scrolled: scroller ? scroller.scrollTop : null,
        scroller: scroller ? scroller.className || scroller.tagName : null,
      };
    }, flashRow);
    check(after.rows > before.rows, "the pane widened its window to reach a row it had not drawn", `${before.rows} -> ${after.rows}`);
    check(after.inView === true, "the row is inside the pane's own scroller", `centred off by ${after.centred}px, scrollTop ${after.scrolled} on ${after.scroller}`);
    check(Math.abs(after.centred ?? 9999) <= 90, "and it is centred there, not merely visible", `${after.centred}px from the middle`);
    // The capture the brief asks for is the flash ITSELF, and a pulse is one animation long: the float goes back to the
    // Chat (the anchor has to be on screen to be pressed), the press is repeated, and the shot is taken while the class
    // is on the row, because a picture after the fade would show an ordinary row.
    await page.click('#as-subtabs [data-as-subtab="chat"]');
    await page.click(link);
    await page
      .waitForFunction((sel) => Boolean(document.querySelector(sel)?.classList.contains("flash")), flashRow, { timeout: 6000 })
      .catch(() => note("the pulse was not on the row at capture time"));
    note(`shot ${await shot(page, "2-flash-on-the-row.png")}`);
    const faded = await waitFor(
      () => page.evaluate((sel) => !document.querySelector(sel)?.classList.contains("flash"), flashRow),
      { timeoutMs: 6000, stepMs: 150, what: "the pulse to fade" },
    );
    check(Boolean(faded), "the pulse fades on its own");

    // ---- 3. the owner chip: a sentence started, nothing sent ---------------------------------------------
    console.log("\n== 3. the chip starts the reader's sentence ==");
    await page.click("#btn-assistant");
    await page.waitForSelector("#assistant.hidden, #assistant[hidden]", { state: "attached" }).catch(() => {});
    const chipSel = 'section.project tr.row td.owner button.owner-tag[data-owner-assistant="assistant-2"]';
    const chip = await waitFor(() => page.locator(chipSel).count().then((n) => n >= 1), { timeoutMs: 15_000, stepMs: 200, what: "the owner chip" });
    check(Boolean(chip), "the owner cell is a button for Assistant #2");
    const chipData = await page.evaluate((sel) => {
      const b = document.querySelector(sel);
      return b ? { tag: b.tagName, text: b.textContent.trim(), project: b.dataset.ownerProject, worktree: b.dataset.ownerWorktree, branch: b.dataset.ownerBranch } : null;
    }, chipSel);
    check(chipData?.tag === "BUTTON", "it is a button, not a span", String(chipData?.tag));
    check(chipData?.text === "M2", "it still reads as the compact tag", String(chipData?.text));
    check(chipData?.project === "task-refs-repo" && chipData?.worktree === treeName && chipData?.branch === BRANCH, "and it carries the row's own three names", JSON.stringify(chipData));
    const sentBefore = posted.length;
    await page.click(chipSel);
    const boxSel = "#as-first-text-2";
    const want = "Regarding task-refs-repo owner-chip-ab12cd work/owner-chip: ";
    const boxText = await waitFor(
      async () => {
        const t = await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? "", boxSel);
        return String(t || "").trim() ? t : null;
      },
      { timeoutMs: 10_000, stepMs: 100, what: "the composer sentence" },
    );
    // Every box in the panel writes its trailing spaces non-breaking (paste-chips.js writeBox: a last space that
    // collapsed would leave the caret unable to move past it), so the sentence is compared after that one fold.
    const norm = (s) => String(s ?? "").replace(/\u00a0/g, " ");
    check(norm(boxText) === want, `the composer reads "Regarding <project> <worktree> <branch>: "`, JSON.stringify({ got: norm(boxText), want }));
    // The caret is compared on the sentence the reader would type on from, so the same one fold is applied.
    const normText = norm(boxText);
    const composer = await page.evaluate((sel) => {
      const box = document.querySelector(sel);
      if (!box) return null;
      const word = box.textContent;
      return {
        text: word,
        focused: document.activeElement === box,
        caret: window.getSelection()?.anchorOffset,
        caretNodeText: window.getSelection()?.anchorNode?.textContent || "",
        float: document.querySelector("#assistant")?.hidden ? "hidden" : "shown",
        onChat: document.querySelector('#as-subtabs [data-as-subtab="chat"]')?.classList.contains("is-on") || false,
      };
    }, boxSel);
    check(composer?.focused === true, "the box has the focus, so the reader types immediately");
    check(composer?.caret === String(normText).length, "the caret sits at the end of the sentence", `caret ${composer?.caret} of ${String(normText).length}`);
    check(/: $/.test(normText), "and the sentence ends at the colon and its space", JSON.stringify(normText.slice(-4)));
    check(composer?.onChat === true, "the float is on Assistant #2's Chat");
    check(posted.length === sentBefore, "nothing was posted by the press", `${posted.length - sentBefore} request(s)`);
    const queued = (await GET("/api/assistant/queue?assistantId=assistant-2")).body?.queue?.tasks || [];
    check(!queued.some((t) => /^Regarding /.test(String(t.title || t.prompt || ""))), "and no task was filed from it");
    note(`shot ${await shot(page, "3-prefilled-focused-composer.png")}`);

    // ---- 4. the chart, in the page these features were just driven on --------------------------------------
    //
    // The two earlier PRs have their own gates, and this run reports their verdicts beside its own:
    // tools/verify-chart-edges.mjs for PR 760 (both edges ruled, the action column's floor, the 10px gutter) and
    // tools/verify-assistant-command-card.mjs for PR 758 (the console card's frame is the handle, its hint slot empty).
    // What is measured HERE is the cheap version, because a transcript change must not move the board's columns: the
    // chart is read with the float shut, so the width under it is the width the reader sees.
    console.log("\n== 4. the worktree chart is where it was ==");
    await page.click("#btn-as-close");
    await page.waitForTimeout(400);
    const edges = await page.evaluate(() => {
      const section = [...document.querySelectorAll("section.project")].find((s) => s.querySelector("tr.row"));
      const wrap = section?.querySelector(":scope > .wt-scroll");
      if (!wrap) return null;
      const cs = getComputedStyle(wrap);
      const table = wrap.querySelector("table");
      const tr = table?.getBoundingClientRect();
      // The action cell with the most controls - the widest that column ever gets on this board - and the clear space
      // its last control keeps from the table's right rule, which is the number PR 760's floor is about.
      let best = null;
      for (const row of wrap.querySelectorAll("tbody tr.row")) {
        const cell = row.querySelector('td[data-col-id="actions"], td.actions, td:last-child');
        const controls = cell ? [...cell.querySelectorAll("button")] : [];
        if (!best || controls.length > best.controls.length) best = { cell, controls };
      }
      const last = best?.controls?.[best.controls.length - 1];
      const lr = last?.getBoundingClientRect();
      return {
        float: document.querySelector("#assistant")?.hidden ? "hidden" : "shown",
        left: cs.borderLeftWidth, right: cs.borderRightWidth,
        leftColor: cs.borderLeftColor, rightColor: cs.borderRightColor,
        controls: best?.controls?.length || 0,
        gap: lr && tr ? Math.round((tr.right - lr.right) * 10) / 10 : null,
        slack: wrap.scrollWidth - wrap.clientWidth,
      };
    });
    check(edges?.float === "hidden", "the float is shut, so the chart is read at its own width", edges?.float);
    check(edges?.left === "1px" && edges?.right === "1px", "both edges of the chart are still ruled", JSON.stringify({ left: edges?.left, right: edges?.right }));
    check(edges?.leftColor === edges?.rightColor, "and they are the same rule", `${edges?.leftColor} / ${edges?.rightColor}`);
    check((edges?.gap ?? -1) >= 10, "the action column's last control keeps its room from the right rule", `${edges?.gap}px, ${edges?.controls} controls`);
    check((edges?.slack ?? 99) <= 1, "and the table is no wider than its wrapper", `${edges?.slack}px`);
    },
    { viewport: { width: 1440, height: 900 } },
  );
} catch (err) {
  failures += 1;
  console.log(`FAIL  the gate itself: ${String((err && err.stack) || err)}`);
  console.log(panel.log().split(/\r?\n/).slice(-12).join("\n"));
} finally {
  await panel.stop();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* Windows can hold a file for a moment; the verdict does not depend on the cleanup */
  }
}

console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} checks answered${failures ? `, ${failures} failed` : ""}`);
console.log(`shots ${shotsDir.replace(/\\/g, "/")}`);
process.exit(failures ? 1 : 0);
