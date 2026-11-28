// The Queue sub-tab as a column of CARDS, and the "unowned" label gone.
//
//   node tools/verify-queue-cards.mjs
//
// Brief (queue row #71): the pane renders cards, and "unowned" is gone. What this gate drives, in order:
//
//   1. a panel of its own (tools/panel-testkit.mjs: throwaway data directory, a scanned repo, a free port) with a
//      SEEDED queue file written straight to disk - a stale running task with two agents, a queued task whose files
//      clash with a LIVE running holder (a run seeded into the job store, because the lane rule reads liveness and
//      not the state word), a parked task with no owner (the record that used to paint "unowned") and a done one;
//   2. the real pane in headless Chromium, at 1280 then 340 wide: every row renders as a card (a surface, a
//      non-zero border-radius, a visible gap to the next card), the presses sit in the main row's top-right corner
//      beside the body, and every fact the row carries is still on it - the head (#id, title, state mark), one
//      sub-row per agent leading with `project:branch` and its pill, the meta line naming the project, the folded
//      `tree · files · attempts · detail` line, the stale/skipped/parked notes, and every glyph with its title= and
//      aria-label=;
//   3. the row body still carries data-as-qopen (equal to the row's current thread) and every glyph keeps
//      data-as-qact, so the click behaviour is untouched.
//
// Screenshots land in QUEUE_CARDS_OUT (default: a directory under the OS temp) at 1280 and 340 wide.
//
// This gate is meant to be RED on the tree it replaces: the base row is a bordered bullet with border-radius 0, no
// card surface, no body wrapper and an owner label that says "unowned" when the task has no owner. The red run is
// quoted in the commit and the PR — see the landing note.
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { freePort, ROOT, waitFor } from "./panel-testkit.mjs";
import { loadPlaywright } from "./browser.mjs";
import { readStyleSheets } from "./style-sheets.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 240_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing — see the last line printed above.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

let checks = 0;
let failures = 0;
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
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const slash = (p) => String(p || "").replace(/\\/g, "/");
const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

const outDir = process.env.QUEUE_CARDS_OUT || path.join(tmpdir(), "wtgui-queue-cards");
mkdirSync(outDir, { recursive: true });

// The seed: one task per state, with the fields the row draws. Task 1's two threads are one CURRENT run and one
// earlier one, and it names no run id and has no live run behind either thread, so it is STALE - the note. Task 5 is
// the LIVE holder the lane rule needs: its run is in the sandbox job store (below), its files overlap task 2's, and
// task 2 is queued behind it, so the SKIPPED note reads "files in use by #5". Before the lane rule landed (queue row
// 293) ANY running row made a queued row skip; now only a row a LIVE job is working does, which is why the stale and
// the live row are both here. Task 3 has NO owner - the record that used to print the label this brief deletes.
// Every task has an agent, so every row draws a pill.
const at = new Date("2026-11-02T09:00:00.000Z").toISOString();
const TASKS = [
  {
    id: 1,
    title: "Land the queue cards",
    detail: "the card skin, and the deleted label",
    state: "running",
    owner: "assistant-1",
    createdBy: "reader",
    createdAt: at,
    startedAt: at,
    thread: "seed-thread-before",
    threads: ["seed-thread-before", "seed-thread-live"],
    worktree: "C:/dev/agent-worktree-gui/.worktrees/queue-cards-seed",
    files: ["public/assistant.js", "public/queue.css", "tools/verify-queue-cards.mjs", "test/assistant-queue-ui.test.js", "package.json"],
    attempts: 2,
  },
  {
    id: 2,
    title: "Tighten the meta line",
    state: "queued",
    owner: "assistant-1",
    createdBy: "reader",
    createdAt: at,
    thread: "seed-thread-queued",
    threads: ["seed-thread-queued"],
    files: ["public/assistant.js"],
  },
  {
    id: 3,
    title: "Park on the DBA's verify",
    state: "parked",
    owner: null,
    createdBy: "reader",
    createdAt: at,
    thread: "seed-thread-parked",
    threads: ["seed-thread-parked"],
    reason: "waiting on the DBA's verify",
  },
  {
    id: 4,
    title: "Ship the removed label",
    state: "done",
    owner: "assistant-1",
    createdBy: "reader",
    createdAt: at,
    doneAt: at,
    doneBy: "reader",
    thread: "seed-thread-done",
    threads: ["seed-thread-done"],
  },
  {
    id: 5,
    title: "Hold the lane on the split sheets",
    detail: "the live holder a queued row waits behind",
    state: "running",
    owner: "assistant-1",
    createdBy: "reader",
    createdAt: at,
    startedAt: at,
    runId: "seed-run-holder",
    thread: "seed-thread-holder",
    threads: ["seed-thread-holder"],
    files: ["public/assistant.js", "public/queue.css"],
    attempts: 1,
  },
];

let panel = null;
let liveBrowser = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-cards-"));
  const repos = path.join(dir, "repos");
  mkdirSync(repos, { recursive: true });

  const liveBefore = listenersOn(7331);
  const port = await freePort();
  ok("the sandbox port is not the live one", port !== 7331, `port ${port}`);
  note(`temp root ${dir}`);

  // THE LIVE HOLDER'S RUN. A queued row is skipped only by a row a LIVE job is working (lib/spawn-check.js
  // `liveRowHolders`), so task 5's run has to exist in the job store. The store is read at boot, the sandbox's
  // gateway is a dead port, and the boot reconcile skips a restored run it cannot ask about ("a restored turn stays
  // live and pending") - so one record, written before the panel starts, reads LIVE for the whole gate.
  const jobsFile = path.join(dir, "logs", "jobs.json");
  mkdirSync(path.dirname(jobsFile), { recursive: true });
  writeFileSync(
    jobsFile,
    `${JSON.stringify(
      {
        savedAt: at,
        jobs: [
          {
            id: "hold0001",
            runId: "seed-run-holder",
            thread: "seed-thread-holder",
            turn: 0,
            prompt: "seed: hold the lane on the split sheets",
            cwd: path.join(dir, "panel-cwd"),
            worktreePath: path.join(dir, "holder-tree"),
            status: "running",
            startedAt: at,
            lines: [{ kind: "out", text: "holding the lane", lid: 1, at: new Date(at).getTime() }],
          },
        ],
      },
      null,
      1,
    )}\n`,
    "utf8",
  );

  const configPath = path.join(dir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [repos],
        refreshSeconds: 4,
        worktreeSeconds: 2,
        midSeconds: 8,
        threads: 1,
        scanMode: "all",
        defaultCwd: path.join(dir, "panel-cwd"),
        projectsCacheFile: path.join(dir, "logs", "projects.json"),
        // The seeded store above, named explicitly so the gate does not lean on the sandbox layout rule.
        jobsFile,
        // A dead port and a switched-off sentry: this gate is a store and a pane, and nothing here may wake a model.
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const base = `http://127.0.0.1:${port}`;
  const panelLog = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: path.join(dir, "hermes"), PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  child.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel = {
    base,
    port,
    dir,
    log: () => panelLog.join("\n"),
    stop: async () => {
      child.kill();
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 15_000, stepMs: 200, what: "the panel to exit" });
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* Windows can still hold a file for a moment; the verdict does not depend on the cleanup */
      }
    },
  };
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, {
    timeoutMs: 90_000,
    stepMs: 300,
    what: "the sandbox panel to answer /api/state",
  });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
  note(`panel ${base} (live board 7331 untouched: ${liveBefore} listener(s) before)`);
  ok("the sandbox is bound on its own port", listenersOn(port) >= 1, `${listenersOn(port)} listener(s) on :${port}`);

  // The boot's branch-parents walk only logs a line when it HAS branches to learn, and an empty sandbox has none. The
  // route reads below are the liveness proof instead: a blocked event loop cannot answer them.
  note("the sandbox is answering its routes (no branch-parents line expected in an empty scan root)");

  // ---- the seeded queue file ---------------------------------------------------------------------
  console.log("\n== the store: a seeded queue file, read by the real route ==");
  const view = async () => (await (await fetch(`${base}/api/assistant/queue?assistantId=assistant-1`)).json()).queue || null;
  const before = await view();
  ok("Assistant #1's queue is found at boot", before?.found === true, JSON.stringify({ found: before?.found, error: before?.error }));
  const queueFile = before?.file || "";
  ok("…and names a queue.json on disk", existsSync(queueFile), slash(queueFile));
  writeFileSync(queueFile, `${JSON.stringify({ version: 1, nextId: 6, tasks: TASKS }, null, 2)}\n`, "utf8");
  const seeded = await view();
  check("the route reads the seed: five tasks, one running pair, every other state once", seeded?.tasks?.map((t) => [t.id, t.state]), [[1, "running"], [2, "queued"], [3, "parked"], [4, "done"], [5, "running"]]);
  ok("…the first running task is stale (no live run behind its threads), so the row has a note to draw", seeded?.tasks?.find((t) => t.id === 1)?.stale === true, String(seeded?.tasks?.find((t) => t.id === 1)?.staleWhy || ""));
  ok("…the second running task is LIVE, its run answered by the seeded store", seeded?.tasks?.find((t) => t.id === 5)?.stale !== true, String(seeded?.tasks?.find((t) => t.id === 5)?.staleWhy || "(live)"));
  ok("…the queued task is skipped against the live holder, so the row has its reason", /files in use by #5/.test(seeded?.tasks?.find((t) => t.id === 2)?.skipped || ""), seeded?.tasks?.find((t) => t.id === 2)?.skipped || "(none)");
  ok("…and the stale row holds no lane: the skip names the live holder, never #1", !/files in use by #1\b/.test(seeded?.tasks?.find((t) => t.id === 2)?.skipped || ""));
  // A second assistant, so the row's ➡️ Move control (and its title/aria-label) is part of "every glyph".
  const made = await fetch(`${base}/api/assistant/assistants`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok("a second assistant exists, so every row draws its Move glyph", made.status === 201, `HTTP ${made.status}`);

  // The source half of "unowned appears nowhere": a label deleted from the renderer cannot come back silently.
  const assistantSrc = readFileSync(path.join(ROOT, "public/assistant.js"), "utf8");
  const styleSrc = readStyleSheets({ root: ROOT });
  ok("public/assistant.js carries no \"unowned\" string", !assistantSrc.includes("unowned"));
  ok("no sheet the page links carries an .as-task-owner rule", !styleSrc.includes(".as-task-owner"));

  // ---- the pane, in a browser --------------------------------------------------------------------
  console.log("\n== the pane, in a real browser ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the card skin was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<a dir holding node_modules/playwright>");
    failures += 1;
  } else {
    const pageErrors = [];
    liveBrowser = await pw.chromium.launch({ headless: true });
    const context = await liveBrowser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#job-prompt", { state: "visible", timeout: 25_000 });
    await page.locator("#btn-assistant").click();
    await page.waitForSelector("#assistant", { state: "visible" });
    await page.waitForSelector('#as-tabs [data-as-tab="assistant-1"]');
    await page.waitForSelector("#as-subtabs", { state: "visible" });
    await page.click('#as-subtabs [data-as-subtab="queue"]');
    await page.waitForSelector("#as-queue:not(.hidden)");

    const rowsReady = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => n === 5), {
      timeoutMs: 20_000,
      stepMs: 200,
      what: "the five seeded cards to paint",
    });
    ok("the pane paints one card per task", rowsReady, `${await page.locator("#as-queue .as-task").count()} card(s)`);
    if (!rowsReady) note(`pane text: ${(await page.locator("#as-queue").innerText()).replace(/\s+/g, " ").slice(0, 700)}`);

    // THE CARD THIS GATE PINS IS THE CURRENT ONE, and four of the seven assertions below were written against a
    // card that no longer exists (queue row #489). `48f484e4` moved the presses out of the card's bottom edge and
    // into a right-hand column of `.as-task-main` (top-aligned with the head), moved the tree, the files, the
    // attempts and the detail behind the card's own closed `tree · files` disclosure, and gave `.as-task.is-done`
    // the group's own fill (public/queue.css:52) so a finished row recedes instead of carrying the raised surface.
    // `f926cf32` (queue row #410) put the project in front of every agent line and the run chip at its back, and the
    // task-level meta line now names the project and the PR - or steps aside entirely when each agent line already
    // says where it worked. Each re-pin below asserts the fact the current card DRAWS, with the reason beside it; a
    // fact that could only pass by asking for less (a transparent surface, a bare thread, a files fragment that is no
    // longer there) is not one of them.
    const snap = () =>
      page.evaluate(() => {
        const host = document.querySelector("#as-queue");
        const rows = [...host.querySelectorAll(".as-task")];
        const groupBg = getComputedStyle(host.querySelector(".as-group") || host).backgroundColor;
        const r2 = (n) => Math.round(n * 10) / 10;
        return {
          html: host.innerHTML,
          text: host.innerText,
          bodyText: document.body.innerText,
          groupBg,
          rows: rows.map((el) => {
            const cs = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            const body = el.querySelector(".as-task-body");
            const actions = el.querySelector(".as-task-actions");
            const act = actions ? actions.getBoundingClientRect() : null;
            const note = el.querySelector(".as-task-note");
            const more = el.querySelector(".as-task-more");
            return {
              id: el.dataset.asQrow,
              qthread: el.dataset.asQthread,
              radius: Number.parseFloat(cs.borderTopLeftRadius) || 0,
              bg: cs.backgroundColor,
              display: cs.display,
              border: Number.parseFloat(cs.borderTopWidth) || 0,
              top: r2(box.top),
              bottom: r2(box.bottom),
              opacity: cs.opacity,
              bodyOpen: body && body.hasAttribute("data-as-qopen") ? body.dataset.asQopen : null,
              headId: el.querySelector(".as-task-head .mono")?.textContent.trim() || "",
              mark: el.querySelector(".as-task-mark")?.textContent.trim() || "",
              title: el.querySelector(".as-task-title")?.textContent.trim() || "",
              meta: (el.querySelector(".as-task-meta")?.textContent || "").replace(/\s+/g, " ").trim(),
              note: (note?.textContent || "").replace(/\s+/g, " ").trim(),
              agents: [...el.querySelectorAll(".as-task-agent[data-as-qopen]")].map((a) => ({
                thread: a.querySelector(".as-task-agent-thread")?.textContent.trim() || "",
                label: a.querySelector(".as-task-agent-label")?.textContent.trim() || "",
                pill: (a.querySelector(".pill")?.textContent || "").trim(),
                pillClass: a.querySelector(".pill")?.className || "",
              })),
              placeholder: Boolean(el.querySelector(".as-task-agent.is-none")),
              glyphs: [...el.querySelectorAll(".as-task-actions [data-as-qact], .as-task-actions [data-as-qmove-open]")].map((b) => ({
                act: b.dataset.asQact || "move",
                text: b.textContent.trim(),
                title: b.getAttribute("title") || "",
                aria: b.getAttribute("aria-label") || "",
              })),
              mainLast: el.querySelector(".as-task-main")?.lastElementChild === actions,
              cardEndsWith: !el.lastElementChild ? "" : el.lastElementChild === more ? "more" : el.lastElementChild === actions ? "actions" : el.lastElementChild.className,
              actionsGapToTop: act ? r2(act.top - box.top) : null,
              actionsGapToRight: act ? r2(box.right - act.right) : null,
              actionsGapToBottom: act ? r2(box.bottom - act.bottom) : null,
              actionsLeft: act ? r2(act.left) : null,
              bodyRight: body ? r2(body.getBoundingClientRect().right) : null,
              headBottom: el.querySelector(".as-task-head") ? r2(el.querySelector(".as-task-head").getBoundingClientRect().bottom) : null,
              actionsTop: act ? r2(act.top) : null,
              noteTop: note ? r2(note.getBoundingClientRect().top) : null,
              fold: !more
                ? null
                : {
                    open: more.hasAttribute("open"),
                    summary: (more.querySelector("summary")?.textContent || "").trim(),
                    body: (more.querySelector(".as-task-more-body")?.textContent || "").replace(/\s+/g, " ").trim(),
                  },
            };
          }),
        };
      });

    const wide = await snap();
    check("the cards are the five seeded tasks, running first then queue order", wide.rows.map((r) => [r.id, r.title]), [
      ["1", "Land the queue cards"],
      ["5", "Hold the lane on the split sheets"],
      ["2", "Tighten the meta line"],
      ["3", "Park on the DBA's verify"],
      ["4", "Ship the removed label"],
    ]);

    // (a) the deleted label ------------------------------------------------------------------------
    ok("\"unowned\" appears nowhere in the pane's markup", !wide.html.toLowerCase().includes("unowned"));
    ok("…nor in the pane's visible text", !wide.text.toLowerCase().includes("unowned"));
    ok("…nor anywhere on the page", !wide.bodyText.toLowerCase().includes("unowned"));

    // (b) every row is a card ----------------------------------------------------------------------
    ok("every row computes a non-zero border-radius", wide.rows.every((r) => r.radius > 0), JSON.stringify(wide.rows.map((r) => r.radius)));
    // FOUR OPEN CARDS CARRY THE RAISED SURFACE and the done card carries the group's own fill on purpose
    // (public/queue.css:52: `is-done { opacity: .78; background: var(--card) }`), so a finished row recedes into the
    // group instead of claiming the same weight as live work. The check below still refuses a transparent card and
    // still refuses a live card that has lost its surface; what it stopped claiming is that the DONE card, whose
    // greyed fill is the group's, is a defect. The border-and-radius pair on the next line is what keeps a done card
    // reading as a card.
    ok(
      "…a surface of its own, not the group's background",
      wide.rows.every((r) => r.bg !== "rgba(0, 0, 0, 0)") && wide.rows.slice(0, 4).every((r) => r.bg !== wide.groupBg) && wide.rows[4]?.bg === wide.groupBg,
      JSON.stringify({ open: wide.rows[0]?.bg, done: wide.rows[4]?.bg, group: wide.groupBg }),
    );
    ok("…a border, so the surface reads as a card", wide.rows.every((r) => r.border > 0), JSON.stringify(wide.rows.map((r) => r.border)));
    ok("…laid out as a column so the actions can anchor", wide.rows.every((r) => r.display === "flex"), JSON.stringify([...new Set(wide.rows.map((r) => r.display))]));
    const gaps = wide.rows.slice(1).map((r, i) => Math.round((r.top - wide.rows[i].bottom) * 10) / 10);
    ok("…and a visible gap between consecutive cards", gaps.every((g) => g >= 4), JSON.stringify(gaps));

    // the actions column: the main row's last child, top-right, and the card ends with its fold -----------------
    // `48f484e4`: `.as-task-main` is a flex row of the body and the presses, and a card that carries a tree or a
    // file list ends with its `tree · files` disclosure. So the presses are asserted where they now live - last in
    // the main row, level with the head, right of the body - and the card's own last child is asserted to be the
    // fold when there is one (and the main row when the row has nothing to fold), so an actions row that drifts back
    // to the card's bottom edge, or a fold that disappears from under it, fails rather than passes.
    ok(
      "the actions row is the main row's last child, never the card's, which ends with its fold",
      wide.rows.every((r) => r.mainLast && (r.fold ? r.cardEndsWith === "more" : r.cardEndsWith === "as-task-main")),
      JSON.stringify(wide.rows.map((r) => [r.mainLast, r.cardEndsWith, r.fold ? r.fold.summary : "no fold"])),
    );
    ok(
      "…and sits in the card's top-right corner",
      wide.rows.every((r) => r.actionsGapToTop !== null && r.actionsGapToTop >= 0 && r.actionsGapToTop <= 14 && r.actionsGapToRight !== null && r.actionsGapToRight >= 0 && r.actionsGapToRight <= 14),
      JSON.stringify(wide.rows.map((r) => [r.actionsGapToTop, r.actionsGapToRight])),
    );
    ok(
      "…right of the body and above the note, never under it",
      wide.rows.every((r) => r.actionsLeft >= r.bodyRight && r.actionsTop <= r.headBottom && (r.noteTop === null || r.actionsTop < r.noteTop)),
      JSON.stringify(wide.rows.map((r) => [r.bodyRight, r.actionsLeft, r.actionsTop, r.headBottom, r.noteTop])),
    );

    // the facts the row carried before -------------------------------------------------------------
    check("the head still carries #id, title and the state mark", wide.rows.map((r) => [r.headId, r.mark]), [
      ["#1", "●"],
      ["#5", "●"],
      ["#2", "○"],
      ["#3", "⏸"],
      ["#4", "✓"],
    ]);
    // EACH AGENT LINE LEADS WITH `project:branch` (`f926cf32`, queue row #410). Only #1 names a worktree, so only
    // its threads carry the project; #2..#5 hold no tree and draw the bare thread, because a guessed project reads
    // exactly like a fact (public/queue-cards.js:506). The line still ends with its pill and its run chip - the
    // chip's own order is pinned by tools/verify-queue-agents.mjs, which is green at 71/71.
    check("one sub-row per agent, leading with project:branch", wide.rows.map((r) => r.agents.map((a) => a.thread)), [
      ["agent-worktree-gui:seed-thread-before", "agent-worktree-gui:seed-thread-live"],
      ["seed-thread-holder"],
      ["seed-thread-queued"],
      ["seed-thread-parked"],
      ["seed-thread-done"],
    ]);
    ok("…each agent wearing a pill with a word and the card's own class", wide.rows.every((r) => r.agents.length && r.agents.every((a) => a.pill && /\bpill\b/.test(a.pillClass))), JSON.stringify(wide.rows.map((r) => r.agents.map((a) => [a.pill, a.pillClass]))));
    ok("no row fell back to the no-agent placeholder", wide.rows.every((r) => !r.placeholder));
    // THE META LINE NAMES WHERE THE WORK IS NOW, and the tree and the files moved into the card's own closed fold
    // (`48f484e4`). #1 is the only seeded row that names a worktree, so its meta line is `project agent-worktree-gui`
    // exactly; the other four name no project and draw no meta line at all. The fold is read for the facts that left
    // the meta line, so nothing this gate used to prove has been dropped - it is asserted one element lower.
    const foldBody = wide.rows[0]?.fold?.body || "";
    const filesWant = `${TASKS[0].files.slice(0, 4).join(", ")}…`;
    ok(
      "the meta line names the project, and the tree and the files live in the fold",
      wide.rows[0]?.meta === "project agent-worktree-gui" &&
        wide.rows.every((r) => !/\btree\b|\bfiles\b/.test(r.meta)) &&
        wide.rows[0]?.fold?.summary === "tree · files · attempts · detail" &&
        foldBody.includes(`tree ${TASKS[0].worktree}`) &&
        foldBody.includes(`files ${filesWant}`),
      JSON.stringify({ meta: wide.rows[0]?.meta, summary: wide.rows[0]?.fold?.summary, body: foldBody.slice(0, 170) }),
    );
    ok(
      "…and truncates a long file list rather than growing the card",
      !/package\.json/.test(foldBody) && wide.rows.every((r) => r.fold === null || r.fold.open === false),
      JSON.stringify({ files: foldBody.match(/files [^·]*/)?.[0], closed: wide.rows.map((r) => r.fold?.open ?? "no fold") }),
    );
    ok("the running row says STALE with its why", /^STALE — that thread has no live run/.test(wide.rows[0]?.note || ""), wide.rows[0]?.note);
    ok("the live holder row draws no stale or skipped note", !wide.rows[1]?.note, wide.rows[1]?.note || "(none)");
    ok("the queued row says SKIPPED with the clash", /^SKIPPED — files in use by #5/.test(wide.rows[2]?.note || ""), wide.rows[2]?.note);
    ok("the parked row says parked with its reason", /^parked — waiting on the DBA's verify$/.test(wide.rows[3]?.note || ""), wide.rows[3]?.note);
    ok("the done row is still greyed in place", wide.rows[4]?.opacity !== "1", `opacity ${wide.rows[4]?.opacity}`);
    ok("every glyph is drawn with its title= and aria-label=", wide.rows.every((r) => r.glyphs.length >= 5 && r.glyphs.every((g) => g.title && g.aria && g.text)), JSON.stringify(wide.rows[0]?.glyphs.map((g) => [g.act, g.text, g.aria])));
    ok("…including the ➡️ Move control", wide.rows.every((r) => r.glyphs.some((g) => g.act === "move" && g.aria === "Move")));

    // (d) the row body keeps its opener, and every glyph its action --------------------------------
    ok("every row's body still carries data-as-qopen", wide.rows.every((r) => r.bodyOpen === r.qthread && Boolean(r.qthread)), JSON.stringify(wide.rows.map((r) => [r.qthread, r.bodyOpen])));
    ok("…and every glyph still carries data-as-qact (Move keeps its own opener)", wide.rows.every((r) => r.glyphs.filter((g) => g.act !== "move").every((g) => ["running", "queued", "parked", "done", "delete", "reassign"].includes(g.act))));

    await page.screenshot({ path: path.join(outDir, "queue-cards-1280.png") });
    note(`screenshot ${slash(path.join(outDir, "queue-cards-1280.png"))}`);

    // ---- 340 wide: the same cards, still cards -------------------------------------------------
    // A reload AND a reopen at 340: the float's rect is clamped to the WINDOW when it opens, so a 1280 window narrowed
    // to 340 restores a 480-wide window hanging off the right edge. Closing and opening it at 340 is what a reader on
    // a narrow window does, and it is the state the screenshot should show. The float remembers it was open, so the
    // first press closes it and the second reopens it at the clamped width.
    console.log("\n== 340 wide ==");
    await page.setViewportSize({ width: 340, height: 900 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#assistant", { state: "visible", timeout: 25_000 });
    if (await page.locator("#assistant").isVisible()) await page.locator("#btn-assistant").click();
    await page.waitForSelector("#assistant", { state: "hidden", timeout: 10_000 }).catch(() => {});
    await page.locator("#btn-assistant").click();
    await page.waitForSelector("#assistant", { state: "visible", timeout: 10_000 });
    const narrowHead = await page.evaluate(() => ({ win: innerWidth, rail: Math.round(document.getElementById("assistant").getBoundingClientRect().width) }));
    note(`at ${narrowHead.win}px the assistant rail is ${narrowHead.rail}px`);
    if (!(await page.locator("#as-queue").isVisible())) {
      await page.waitForSelector("#as-subtabs", { state: "visible" });
      await page.click('#as-subtabs [data-as-subtab="queue"]');
    }
    await page.waitForSelector("#as-queue:not(.hidden)", { timeout: 25_000 });
    const narrowReady = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => n === 5), {
      timeoutMs: 20_000,
      stepMs: 200,
      what: "the five cards to paint at 340 wide",
    });
    ok("the narrow window paints all five cards again", narrowReady, `${await page.locator("#as-queue .as-task").count()} card(s)`);
    await page.locator("#as-queue .as-task").first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(250);
    const narrow = await snap();
    ok("the narrow pane still paints all five cards", narrow.rows.length === 5, `${narrow.rows.length} card(s)`);
    ok("…each still a card with a non-zero radius", narrow.rows.every((r) => r.radius > 0), JSON.stringify(narrow.rows.map((r) => r.radius)));
    ok("…still with visible spacing between them", narrow.rows.slice(1).every((r, i) => r.top - narrow.rows[i].bottom >= 4), JSON.stringify(narrow.rows.slice(1).map((r, i) => Math.round((r.top - narrow.rows[i].bottom) * 10) / 10)));
    ok("…still with its agent pill and glyphs", narrow.rows.every((r) => r.agents.every((a) => a.pill) && r.glyphs.length >= 5));
    ok("\"unowned\" is still nowhere at 340", !narrow.html.toLowerCase().includes("unowned"));
    await page.screenshot({ path: path.join(outDir, "queue-cards-340.png") });
    note(`screenshot ${slash(path.join(outDir, "queue-cards-340.png"))}`);
    check("no page errors", pageErrors, []);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log(`screenshots in ${slash(outDir)}`);
  console.log(failures ? "RESULT: FAIL" : "RESULT: PASS  QUEUE-CARDS-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panel) console.log(`--- panel log (tail)\n${String(panel.log()).split(/\r?\n/).slice(-25).join("\n")}`);
  console.log(`\n${checks} checks, ${failures} failed`);
  console.log("RESULT: FAIL");
} finally {
  if (liveBrowser) {
    try {
      await liveBrowser.close();
    } catch {
      /* already gone */
    }
    liveBrowser = null;
  }
  if (panel) {
    if (process.env.VERIFY_KEEP === "1") console.log(`VERIFY_KEEP=1 — leaving ${panel.dir} in place`);
    else await panel.stop();
  }
  clearTimeout(watchdog);
}
process.exitCode = failures ? 1 : 0;
