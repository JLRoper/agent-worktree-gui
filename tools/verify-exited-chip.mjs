// HARNESS: LIVE GATE
// The Queue row's EXITED chip is the RE-ATTACH PRESS — proved on the real page, against the real reset route and a
// stub gateway that records every call. Three presses, because the brief asks for three:
//
//   node tools/verify-exited-chip.mjs
//
//   1. a card reading EXITED, pressed by KEYBOARD (Enter) on an assistant with nothing wedged in its store: the card
//      says "nothing was wedged — no run was started", no turn is submitted, and the chip is still EXITED afterwards;
//   2. the same card pressed TWICE quickly: exactly ONE reset on the wire (the page's single-flight answers the second
//      press from the flight already out), still no run;
//   3. the fence seeded underneath it (an `unknown` admission on Assistant #1's thread), then a real mouse press: the
//      stub's resolve is called with the fresh pair, ONE `/api/assistant/say` is submitted with the re-attach sentence,
//      the card says "cleared 1 wedged run(s), run run_new_1 started", and the chip LEAVES EXITED for a live run id.
//
// What it also reads: the chip is a real <button> (role, Tab stop and Enter/Space in one element), a LIVE run's chip is
// not a control (so a healthy agent cannot get a second run), no restart route is called, no page reload happens, the
// panel is the same process afterwards, and Assistant #2's thread is never submitted to or reset.
//
// A sandbox of its own (`tools/reset-harness.mjs`): its own port, HERMES_HOME and job store, a stub gateway, and
// `exitedSeconds: 3600` so the assistant's own EXITED rule cannot wake the thread mid-proof.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bootResetSandbox, insertRows, unknownRows } from "./reset-harness.mjs";
import { loadPlaywright } from "./browser.mjs";
import { waitFor } from "./panel-testkit.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 240_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing — see the last line printed above.\n`);
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
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const slash = (p) => String(p || "").replace(/\\/g, "/");

// Assistant #1's own session: the thread its queue rows run on, and the fixture is the assistant the float opens on.
const THREAD = "panel-assistant";
const OTHER_THREAD = "panel-assistant-2";
const ago = (ms) => new Date(Date.now() - ms).toISOString();

let sandbox = null;
let browser = null;
try {
  // Nothing in the store at boot: the first two presses are the HEALTHY ones. The fence is inserted between them and
  // the third, so one boot proves all three answers.
  const boot = await bootResetSandbox({
    rows: [],
    jobsExtra: [
      // The EXITED card itself: a failed run, newest on Assistant #1's thread, so the queue's chip reads EXITED.
      { id: "card_failed", thread: THREAD, runId: "run_f", status: "failed", prompt: "the turn that exited", startedAt: ago(90_000), endedAt: ago(60_000), lines: [] },
    ],
    config: { assistant: { exitedSeconds: 3600 } },
  });
  sandbox = boot;
  const { panel, gateway, stateDb } = boot;
  gateway.state.runs.run_f = { run_id: "run_f", status: "failed", admission_id: null, execution_generation: 1, pending_controls: [] };
  const base = panel.base;
  note(`sandbox ${slash(boot.sandbox)} on ${base} (panel pid ${panel.pid})`);

  const GET = async (p) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const POST = async (p, body) => {
    const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-panel-token": boot.token }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const jobsOf = async (thread) => ((await GET("/api/jobs")).body.jobs || []).filter((j) => String(j.thread || "") === thread);

  console.log("\n== the fixture: a real panel, an EXITED card, and the assistant's own rule held back ==");
  const settings = (await GET("/api/assistant")).body.settings || {};
  check("the assistant's EXITED rule is held at an hour, so nothing wakes the thread on its own", Number(settings.exitedSeconds), 3600);
  const queue = (await GET("/api/assistant/queue?assistantId=assistant-1")).body.queue || {};
  ok("the queue file is a real path the gate can seed", Boolean(queue.file) && existsSync(queue.file), slash(queue.file));
  mkdirSync(path.dirname(queue.file), { recursive: true });
  writeFileSync(
    queue.file,
    `${JSON.stringify(
      {
        version: 1,
        nextId: 2,
        tasks: [{ id: 1, title: "carry the turn that exited", state: "running", threads: [THREAD], files: [], project: "agent-worktree-gui", detail: "the card the chip sits on" }],
      },
      null,
      1,
    )}\n`,
    "utf8",
  );
  const failed = await jobsOf(THREAD);
  ok("the seeded failed run is the thread's newest job, so its chip reads EXITED", failed.length === 1 && failed[0].status === "failed", JSON.stringify(failed.map((j) => [j.id, j.status, j.runId])));

  const pw = loadPlaywright();
  if (!pw) throw new Error("BROWSER-HALF-NOT-RUN — no Playwright install; set PANEL_PLAYWRIGHT_ROOT to a dir holding node_modules/playwright");
  const pageErrors = [];
  const resets = [];
  const says = [];
  const restarts = [];
  browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });
  page.on("request", (r) => {
    let pathname = "";
    try {
      pathname = new URL(r.url()).pathname;
    } catch {
      return;
    }
    if (r.method() !== "POST") return;
    if (/^\/api\/assistants\/[^/]+\/reset$/.test(pathname)) resets.push(pathname);
    if (pathname === "/api/assistant/say") says.push(pathname);
    if (/restart/i.test(pathname)) restarts.push(pathname);
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-assistant", { state: "visible" });
  // A reload would wipe this: it is the page's proof that a press did not restart anything.
  await page.evaluate(() => {
    window.__probeBoot = "same-document";
  });
  await page.click("#btn-assistant");
  await page.waitForSelector("#assistant", { state: "visible" });
  await page.click('#as-subtabs [data-as-subtab="queue"]');
  await page.waitForSelector("#as-queue:not(.hidden)");
  await page.waitForSelector("#as-queue .as-task [data-as-qreattach]");
  ok("the card paints one EXITED chip to press", (await page.locator("#as-queue .as-task [data-as-qreattach]").count()) === 1, `${await page.locator("#as-queue .as-task [data-as-qreattach]").count()} control(s)`);

  console.log("\n== 1. the chip is a real control: a button, a Tab stop, Enter ==");
  const chip = await page.evaluate(() => {
    const b = document.querySelector("#as-queue .as-task [data-as-qreattach]");
    if (!b) return null;
    return {
      tag: b.tagName,
      type: b.getAttribute("type"),
      tabIndex: b.tabIndex,
      word: b.textContent.trim(),
      glyph: Boolean(b.querySelector(".pill-again")),
      thread: b.dataset.asQreattach,
      own: b.dataset.asQown,
      task: b.dataset.asQid,
      title: b.getAttribute("title") || "",
      label: b.getAttribute("aria-label") || "",
      classes: [...b.classList],
    };
  });
  check("it is a native button whose word is the status and whose glyph says it reacts", {
    tag: chip?.tag,
    type: chip?.type,
    tabIndex: chip?.tabIndex,
    word: chip?.word,
    glyph: chip?.glyph,
  }, { tag: "BUTTON", type: "button", tabIndex: 0, word: "exited↻", glyph: true });
  check("…carrying the thread, the assistant and the task it belongs to", [chip?.thread, chip?.own, chip?.task], [THREAD, "assistant-1", "1"]);
  ok("…the card's own red chip, not a new control beside it", chip?.classes.includes("pill-notrunning") && chip?.classes.includes("is-failed") && chip?.classes.includes("pill-reattach"), chip?.classes.join(" "));
  ok("…and the hover text says what the press does", /re-attach this assistant/.test(chip?.title || "") && /never restarts|restarts the panel/.test(chip?.title || ""), chip?.title?.slice(0, 120));
  ok("…with a label naming the thread", chip?.label === `exited — re-attach this assistant on ${THREAD}`, chip?.label);

  console.log("\n== 2. a HEALTHY card: Enter says nothing was wedged and starts no run ==");
  const before = (await jobsOf(THREAD)).length;
  await page.focus("#as-queue .as-task [data-as-qreattach]");
  await page.keyboard.press("Enter");
  const healthy = await waitFor(
    async () => {
      const text = await page.locator("#as-queue .as-task .as-task-note").last().textContent().catch(() => "");
      return /nothing was wedged/.test(text || "") ? text.trim() : "";
    },
    { timeoutMs: 20_000, stepMs: 150, what: "the card to say nothing was wedged" },
  );
  check("Enter pressed the control — one reset, and no turn at all", [resets.length, says.length], [1, 0]);
  ok("…the card says the no-op out loud", /^nothing was wedged( — it did drop .*)? — no run was started$/.test(healthy || ""), healthy);
  ok("…and it is not painted as a failure", await page.evaluate(() => Boolean(document.querySelector("#as-queue .as-task .as-task-note.is-info"))));
  check("…no run was started on the thread", (await jobsOf(THREAD)).length, before);
  ok("…and the chip still reads EXITED, because nothing changed", (await page.locator("#as-queue .as-task [data-as-qreattach]").count()) === 1);
  ok("…the press did not open the agent's card instead (the queue pane is still the pane on screen)", await page.evaluate(() => !document.querySelector("#as-queue").classList.contains("hidden")));

  console.log("\n== 3. pressed TWICE quickly: one reset, still no run ==");
  // Two clicks in the same task, so the second lands while the first request is still out. `disabled` and the
  // in-flight set are the two halves of the guard; the count is what proves it.
  const beforeDouble = resets.length;
  await page.evaluate(() => {
    const b = document.querySelector("#as-queue .as-task [data-as-qreattach]");
    b.click();
    b.click();
  });
  await page.waitForTimeout(1200);
  check("two presses put exactly ONE reset on the wire", resets.length - beforeDouble, 1);
  check("…and no turn was submitted", says.length, 0);
  check("…and the thread gained no run", (await jobsOf(THREAD)).length, before);

  console.log("\n== 4. the FENCE, seeded underneath the card: the press clears it and starts one run ==");
  insertRows(stateDb, [{ admissionId: "adm_9", requestId: "run_9", threadId: THREAD, generation: 1 }]);
  gateway.state.runs.run_9 = { run_id: "run_9", status: "unknown", admission_id: "adm_9", execution_generation: 1, pending_controls: [] };
  note("one `unknown` admission on the thread — the state a failed run leaves behind");
  check("…the store reads it as a fence", unknownRows(stateDb, THREAD), ["adm_9"]);
  const dry = await POST("/api/assistants/assistant-1/reset", { dryRun: true });
  check("…a dry run agrees: still fenced, clearable, nothing cleared", [dry.status, dry.body?.stillFenced, dry.body?.verdict], [200, true, "clearable"]);
  const resetsBefore = resets.length;
  await page.click("#as-queue .as-task [data-as-qreattach]");
  const cleared = await waitFor(
    async () => {
      const text = await page.locator("#as-queue .as-task .as-task-note").last().textContent().catch(() => "");
      return /cleared \d+ wedged run\(s\), run \S+ started/.test(text || "") ? text.trim() : "";
    },
    { timeoutMs: 30_000, stepMs: 150, what: "the card to say which run started" },
  );
  check("one more reset — the press's own", resets.length - resetsBefore, 1);
  ok("…the card says what happened AND which run it became", cleared === "cleared 1 wedged run(s), run run_new_1 started", cleared);
  ok("…painted as the working outcome", await page.evaluate(() => Boolean(document.querySelector("#as-queue .as-task .as-task-note.is-good"))));
  const resolved = gateway.state.resolveCalls.at(-1);
  check("…the gateway was asked to settle the fresh pair, and only that pair", [resolved?.runId, resolved?.body, resolved?.keys], ["run_9", { admission_id: "adm_9", execution_generation: 1 }, ["admission_id", "execution_generation"]]);
  check("…and the store no longer fences the thread", unknownRows(stateDb, THREAD), []);
  check("…ONE short turn was submitted", gateway.state.submits.length, 1);
  ok(
    "…with the re-attach sentence, on THIS assistant's thread",
    gateway.state.submits[0]?.body &&
      /you were re-attached after an exit; continue/.test(String(gateway.state.submits[0].body.input || "")) &&
      String(gateway.state.submits[0].body.session_id || "") === THREAD,
    JSON.stringify({ session: gateway.state.submits[0]?.body?.session_id, input: String(gateway.state.submits[0]?.body?.input || "").slice(0, 90) }),
  );
  check("…and exactly one /api/assistant/say left the page", says.length, 1);
  const live = await waitFor(
    async () => {
      const jobs = await jobsOf(THREAD);
      return jobs.find((j) => j.runId === "run_new_1") || null;
    },
    { timeoutMs: 20_000, stepMs: 150, what: "the new run on the thread" },
  );
  ok("the thread carries the run the card named, live", Boolean(live) && live.status === "running", JSON.stringify({ id: live?.id, runId: live?.runId, status: live?.status }));
  const leftExited = await waitFor(
    async () =>
      (await page.locator("#as-queue .as-task [data-as-qreattach]").count()) === 0
        ? await page.evaluate(() => {
            const row = document.querySelector("#as-queue .as-task .as-task-agent .pill");
            return row ? { word: row.textContent.trim(), tag: row.tagName, cls: [...row.classList].join(" ") } : null;
          })
        : null,
    { timeoutMs: 20_000, stepMs: 150, what: "the chip to leave EXITED" },
  );
  check("…the chip LEAVES EXITED for the live word", [leftExited?.tag, leftExited?.word, /pill-running/.test(leftExited?.cls || "")], ["SPAN", "running", true]);
  ok("…and a live run has no re-attach control, so a healthy agent cannot be given a second run", (await page.locator("#as-queue .as-task [data-as-qreattach]").count()) === 0);

  console.log("\n== 5. nothing else moved ==");
  const otherJobs = await jobsOf(OTHER_THREAD);
  ok("Assistant #2's thread was never submitted to", gateway.state.submits.every((s) => String(s.body?.session_id || "") !== OTHER_THREAD), `${gateway.state.submits.length} submit(s), all on ${THREAD}`);
  ok("…and its thread gained no run of this press's", otherJobs.length === 3 && !otherJobs.some((j) => String(j.runId || "") === "run_new_1"), JSON.stringify(otherJobs.map((j) => [j.id, j.status, j.runId])));
  check("no reset or wake named another assistant", [resets.every((p) => p === "/api/assistants/assistant-1/reset"), says.length], [true, 1]);
  check("no restart route was called from the page", restarts, []);
  check("the page was never reloaded (same document throughout)", await page.evaluate(() => window.__probeBoot), "same-document");
  ok("…the page's own stream is still attached to the same panel", ((await GET("/api/health")).body.clients || 0) >= 1, `${(await GET("/api/health")).body.clients} client(s)`);
  ok("…and it is still answering", (await GET("/api/health")).status === 200);
  check("no page errors", pageErrors, []);
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (sandbox) console.log(`--- panel log (tail)\n${String(sandbox.panel.log()).split(/\r?\n/).slice(-25).join("\n")}`);
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* already gone */
    }
    browser = null;
  }
  if (sandbox) await sandbox.stop();
  clearTimeout(watchdog);
}

console.log("\n== summary ==");
console.log(`${checks} checks, ${failures} failed`);
console.log("WHAT WAS DRIVEN: a real panel process over its own data directory, the real reset route, a stub gateway that");
console.log("answers GET /v1/runs, POST /v1/runs and the resolve (and records every call), and headless Chromium on the");
console.log("real float's queue pane: the EXITED chip's markup, Enter on it, two quick presses, and a seeded fence cleared");
console.log("into one live run — with the card's own sentence at every stop, nothing restarted and no other assistant touched.");
if (!failures) console.log("EXITED-CHIP-OK");
process.exitCode = failures ? 1 : 0;
