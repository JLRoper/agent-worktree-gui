// The Queue sub-tab, proved by a real browser over a panel of its own.
//
//   node tools/verify-assistant-queue.mjs
//
// The brief's acceptance list ends with "a browser check that the sub-tab renders all four markers". The unit test
// beside this gate (test/assistant-queue-ui.test.js) slices the row renderer out of `public/assistant.js` and drives
// it with stubs — that pins the HTML, not the pane: it never boots a panel, never answers the route and never paints
// a real row. This gate is the browser half. What is driven, in order:
//
//   1. the STORE: a booted panel seeds `assistants/assistant-1/queue.json` beside its charter, the route reports that
//      file and it is really on disk; creating Assistant #2 seeds its own file at the same path shape (item 1);
//   2. the ROUTES: GET one assistant's queue and the list form, POST add / edit / state / reassign / delete — the
//      reassign records `movedFrom` AND moves the record into the other assistant's file, the delete really removes
//      the row (item 2);
//   3. the WAKE DIGEST the same route answers with: the top of the queue, every running task with its thread, the
//      stale flag and the conflict's skip reason (items 3, 4, 6);
//   4. the PANE, in headless Chromium: the session's third sub-tab exists, pressing it paints one row per task with
//      its marker (● running, ○ queued, ⏸ parked, ✓ done), the done row greyed in place, the running row's thread and
//      STALE sentence, the queued row's files and SKIPPED sentence, the owner, and the Move/delete controls — then a
//      Move and a delete are actually pressed (items 4, 5, 6, 7, 8).
//
// Everything runs in a sandbox of its own: `tools/panel-testkit.mjs` gives it a throwaway data directory, a scanned
// repo and a free port, and `assistant.enabled` is false with a dead `apiServer` so nothing can spawn a run. The live
// board on 7331 is not touched, and its listener count is compared before and after.
//
// The browser half needs a Playwright install; without one this says BROWSER-HALF-NOT-RUN and fails rather than
// passing on a half that never ran.
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { freePort, ROOT, waitFor } from "./panel-testkit.mjs";
import { loadPlaywright } from "./browser.mjs";

// A hang here would otherwise be silent (a browser left open keeps node's loop alive and the log never lands).
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
const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

// ---- the sandbox ---------------------------------------------------------------------------------
let panel = null;
let liveBrowser = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-"));
  const repos = path.join(dir, "repos");
  const repo = path.join(repos, "sandbox-repo");
  const home = path.join(dir, "hermes-home");
  const configDir = path.join(dir, "panel");
  const cwdDir = path.join(dir, "panel-cwd");
  for (const d of [repo, home, configDir, path.join(configDir, "logs")]) mkdirSync(d, { recursive: true });
  const git = (args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
  if (!existsSync(path.join(repo, ".git"))) {
    git(["init", "-q", "-b", "main"]);
    writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
    git(["add", "."]);
    git(["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
  }

  const liveBefore = listenersOn(7331);
  const port = await freePort();
  ok("the sandbox port is not the live one", port !== 7331, `port ${port}`);
  note(`temp root ${dir}`);

  const configPath = path.join(configDir, "config.json");
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
        defaultCwd: cwdDir,
        projectsCacheFile: path.join(configDir, "logs", "projects.json"),
        // A DEAD port and a switched-off sentry: nothing in this test may reach the live gateway or spawn a run. The
        // queue is a store and a pane, so it needs neither.
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  ok("the sandbox config is on disk", existsSync(configPath), configPath);

  const base = `http://127.0.0.1:${port}`;
  const panelLog = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
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
        /* Windows can still hold a file for a moment; the run's verdict does not depend on the cleanup */
      }
    },
  };
  // The boot's own branch-parents pass is a synchronous git walk (~20 s on a cold temp repo here), so this waits past
  // it rather than on a tight clock: the panel answers /api/state as soon as its event loop is free.
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, {
    timeoutMs: 90_000,
    stepMs: 300,
    what: "the sandbox panel to answer /api/state",
  });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
  note(`panel ${base} (live board 7331 untouched: ${liveBefore} listener(s) before)`);
  ok("the sandbox is bound on its own port", listenersOn(port) >= 1, `${listenersOn(port)} listener(s) on :${port}`);
  check("the live board's listener count is unchanged by this run", listenersOn(7331), liveBefore);

  const GET = async (p) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const POST = async (p, body) => {
    const r = await fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const queueOf = async (id = "assistant-1") => (await GET(`/api/assistant/queue?assistantId=${id}`)).body.queue || null;

  // ---- 1. the store, for every assistant including #1 -------------------------------------------
  console.log("\n== the store: one queue file per assistant, #1 included ==");
  const first = await GET("/api/assistant/queue?assistantId=assistant-1");
  check("GET one assistant's queue answers 200", first.status, 200);
  const one = first.body.queue || {};
  ok("Assistant #1's queue is FOUND at boot, not 'created on first write'", one.found === true, JSON.stringify({ found: one.found, error: one.error }));
  ok(
    "…at state/assistants/assistant-1/queue.json",
    /\/assistants\/assistant-1\/queue\.json$/.test(slash(one.file)),
    slash(one.file),
  );
  ok("…and that file is really on disk", Boolean(one.file) && existsSync(one.file), slash(one.file));
  check("its empty counts", one.counts, { total: 0, queued: 0, running: 0, parked: 0, done: 0, stale: 0, conflict: 0 });
  const list = await GET("/api/assistant/queue");
  ok("GET with no id is the list form, one view per assistant", Array.isArray(list.body.queues) && list.body.queues.length === 1, JSON.stringify(list.body.queues?.map((q) => q.assistantId)));

  // ---- 2. the routes -----------------------------------------------------------------------------
  console.log("\n== the routes: add, state, edit, reassign, delete ==");
  const added = [];
  const add = async (payload) => {
    const r = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "add", ...payload });
    added.push(r);
    return r;
  };
  const t1 = await add({ title: "land the queue sub-tab's copy", detail: "the row's words", files: ["public/assistant.js"], owner: "assistant-1" });
  const t2 = await add({ title: "rewrite the queue's file claims", files: "lib/assistant/queue.js, public/assistant.js", thread: "queue-gate-thread-2", owner: "assistant-1" });
  const t3 = await add({ title: "SQL verify for the queue store", owner: "assistant-1" });
  const t4 = await add({ title: "land the per-assistant queue", owner: "assistant-1" });
  check("add answers 200 four times, ids 1..4", added.map((r) => [r.status, r.body.task?.id, r.body.task?.state]), [[200, 1, "queued"], [200, 2, "queued"], [200, 3, "queued"], [200, 4, "queued"]]);
  ok("the creator is recorded", added[0].body.task?.createdBy === "reader" && Boolean(added[0].body.task?.createdAt), JSON.stringify({ by: added[0].body.task?.createdBy, at: added[0].body.task?.createdAt }));
  ok("files are normalised and de-duplicated", JSON.stringify(added[1].body.task?.files) === JSON.stringify(["lib/assistant/queue.js", "public/assistant.js"]), JSON.stringify(added[1].body.task?.files));

  const running = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "state", id: 2, state: "running" });
  ok("state → running stamps startedAt", running.body.task?.state === "running" && Boolean(running.body.task?.startedAt), JSON.stringify({ state: running.body.task?.state, at: running.body.task?.startedAt }));
  const parked = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "state", id: 3, state: "parked", reason: "waiting on the DBA's verify" });
  ok("state → parked keeps the reason", parked.body.task?.state === "parked" && parked.body.task?.reason === "waiting on the DBA's verify", JSON.stringify({ state: parked.body.task?.state, reason: parked.body.task?.reason }));
  const done = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "state", id: 4, state: "done", by: "panel" });
  ok("state → done records who finished it", done.body.task?.state === "done" && done.body.task?.doneBy === "panel", JSON.stringify({ state: done.body.task?.state, by: done.body.task?.doneBy }));
  const edited = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "edit", id: 1, detail: "the row's words, edited" });
  ok("edit changes the words", edited.body.task?.detail === "the row's words, edited", JSON.stringify(edited.body.task?.detail));

  // ---- 3/4/6. the digest: top queued, every running task, stale and skipped ----------------------
  console.log("\n== the wake digest the same route answers with ==");
  const view = await queueOf();
  check("counts after the four states", view.counts, { total: 4, queued: 1, running: 1, parked: 1, done: 1, stale: 1, conflict: 1 });
  const digest = view.digest || [];
  ok("the header counts every state and names the stale one", /^Your task queue \(1 queued · 1 running, 1 stale · 1 parked · 1 done\):$/.test(digest[0] || ""), digest[0]);
  ok("the queued task is listed with its state, thread, tree, PR, owner, files and the SKIP reason", digest.some((l) => /^- ○ #1 queued · land the queue sub-tab's copy · thread \(none\) · tree \(none\) · PR none · owner assistant-1 · files public\/assistant\.js · SKIP: files in use by #2 \(stale\)/.test(l)), digest.find((l) => l.includes("#1")));
  ok("the running task is listed with its state, thread, tree and PR", digest.some((l) => /^- ● #2 running · .* · thread queue-gate-thread-2 · tree \(none\) · PR none/.test(l)), digest.find((l) => l.includes("#2")));
  ok("…and marked STALE, with why", digest.some((l) => /STALE: that thread has no live run/.test(l)), digest.find((l) => l.includes("STALE")));
  ok("the parked task is listed with its state, thread, tree, PR and reason", digest.some((l) => /^- ⏸ #3 parked · SQL verify for the queue store · thread \(none\) · tree \(none\) · PR none · PARKED: waiting on the DBA's verify$/.test(l)), digest.find((l) => l.includes("#3")));
  ok("done work is a count, not a line", !digest.some((l) => l.includes("#4 ")), digest.find((l) => l.includes("#4")) || "(absent)");
  const stale = view.tasks.find((t) => t.id === 2);
  ok("the running task carries stale + staleWhy", stale?.stale === true && /no live run/.test(stale?.staleWhy || ""), JSON.stringify({ stale: stale?.stale, why: stale?.staleWhy }));

  // ---- 2 (cont). a second assistant: its own store, and a real reassign ---------------------------
  console.log("\n== a second assistant, its own queue file, and a reassign ==");
  const created = await POST("/api/assistant/assistants", {});
  check("a second assistant is created", created.status, 201);
  const second = await GET("/api/assistant/queue?assistantId=assistant-2");
  const two = second.body.queue || {};
  ok("Assistant #2's queue is found too — not created on its first write", two.found === true, JSON.stringify({ found: two.found, file: slash(two.file), error: two.error }));
  ok("…at the same path shape", /\/assistants\/assistant-2\/queue\.json$/.test(slash(two.file)), slash(two.file));
  ok("…and on disk", Boolean(two.file) && existsSync(two.file), slash(two.file));
  const moved = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "reassign", id: 1, owner: "assistant-2" });
  ok("Move hands the task to Assistant #2", moved.body.task?.owner === "assistant-2", JSON.stringify(moved.body.task?.owner));
  check("…and records where it came from", (moved.body.task?.movedFrom || []).map((m) => [m.from, m.to]), [["assistant-1", "assistant-2"]]);
  // A Move is a move between QUEUES: the record leaves #1's file and enters #2's under an id of its own. Asserting only
  // the owner let the task sit in the queue whose page it was created on while the assistant it was "moved to" never
  // saw it — the defect this shipped check certified.
  const afterMove = await queueOf();
  ok("…so it leaves Assistant #1's queue", !afterMove.tasks.some((t) => t.id === 1), JSON.stringify(afterMove.tasks.map((t) => t.id)));
  check("…which now counts three", [afterMove.counts.total, afterMove.counts.queued], [3, 0]);
  const arrived = await queueOf("assistant-2");
  const landed = arrived.tasks.find((t) => t.title === "land the queue sub-tab's copy") || null;
  ok("…and arrives in Assistant #2's with its own id", Boolean(landed) && landed.id === 1 && landed.owner === "assistant-2", JSON.stringify(arrived.tasks.map((t) => [t.id, t.title, t.owner])));
  check("…carrying the move record", (landed?.movedFrom || []).map((m) => [m.from, m.to]), [["assistant-1", "assistant-2"]]);
  check("…its title and files intact", [landed?.title, landed?.files], ["land the queue sub-tab's copy", ["public/assistant.js"]]);
  const sameOwner = await POST("/api/assistant/queue", { assistantId: "assistant-1", action: "reassign", id: 2, owner: "assistant-1" });
  ok("a Move to the assistant that already carries the task is refused", sameOwner.status === 400 && /already carries #2/.test(sameOwner.body.error || ""), JSON.stringify(sameOwner.body.error));

  // ---- 5/7/8. the pane, in a browser -------------------------------------------------------------
  // The boot's branch-parents pass is a synchronous git walk that can block the panel's event loop for ~20 s on a
  // cold sandbox. Opening the browser before it finishes makes the page's first fetches fail (Chromium reports
  // ERR_INSUFFICIENT_RESOURCES) and the pane would be measured against a panel that never answered it.
  const bootSettled = await waitFor(() => panelLog.some((l) => /parents: .*resolved/.test(l)), {
    timeoutMs: 120_000,
    stepMs: 500,
    what: "the boot's branch-parents pass to finish",
  });
  ok("the boot's own git pass has finished before the browser opens", bootSettled);

  console.log("\n== the Queue sub-tab, in a real browser ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the sub-tab was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<a dir holding node_modules/playwright>");
    failures += 1;
  } else {
    const pageErrors = [];
    const failedReqs = [];
    const queueReqs = [];
    liveBrowser = await pw.chromium.launch({ headless: true });
    const context = await liveBrowser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("request", (r) => {
      if (r.url().includes("/api/assistant/queue")) queueReqs.push(`${Date.now()} ${r.method()} ${r.url()}`);
    });
    page.on("requestfailed", (r) => failedReqs.push(`${r.method()} ${r.url()} — ${(r.failure() || {}).errorText || "?"}`));
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#job-prompt", { state: "visible", timeout: 25_000 });

    // What the page itself can reach, before any pane asks it to. A browser that cannot fetch at all reads exactly
    // like a pane with a broken URL, so this probe separates the two.
    const probe = await page.evaluate(async () => {
      const out = {};
      for (const p of ["/api/state", "/api/health", "/api/assistant/queue?assistantId=assistant-1", "/api/assistant/queue"]) {
        try {
          const r = await fetch(p);
          out[p] = `${r.status} ${(await r.text()).slice(0, 60)}`;
        } catch (e) {
          out[p] = `ERR ${String((e && e.message) || e)}`;
        }
      }
      return out;
    });
    note(`in-page fetch probe: ${Object.entries(probe).map(([k, v]) => `${k} → ${String(v).split(" ")[0]}`).join(" · ")}`);

    // A fresh context has no remembered view, so the float starts closed. The list of assistants arrives with the
    // first /api/state answer; wait for both assistants' tabs before pressing anything.
    await page.locator("#btn-assistant").click();
    await page.waitForSelector("#assistant", { state: "visible" });
    await page.waitForSelector("#as-tabs [data-as-tab=\"assistant-1\"]");
    await page.waitForSelector("#as-subtabs", { state: "visible" });

    const sub = await page.$$eval("#as-subtabs button", (els) => els.map((el) => ({ key: el.dataset.asSubtab, label: el.innerText.trim() })));
    check("the session's row now ends in a Queue tab", sub.map((s) => s.key), ["chat", "settings", "queue", "worktrees"]);
    check("…labelled", sub.map((s) => s.label), ["Chat", "Settings", "Queue", "Worktrees"]);

    await page.click('#as-subtabs [data-as-subtab="queue"]');
    await page.waitForSelector("#as-queue:not(.hidden)");
    ok("pressing Queue shows the queue pane", await page.locator("#as-queue").isVisible());
    ok("…and puts Chat away", !(await page.locator("#as-chat").isVisible()));
    check("the view record follows the press", await page.evaluate(() => localStorage.getItem("wm.assistantView")), '{"assistant":"assistant-1","subTab":"queue"}');
    const head = await page.locator("#as-queue h4").innerText();
    ok("the pane is named for this assistant's own queue", /task queue — assistant #1's own/i.test(head), head);
    ok("…with the add form live", (await page.locator('#as-queue [data-as-qact="add"]').count()) === 1);

    // Three, not four: the route section already moved task 1 to Assistant #2, so it must NOT be painted here. The
    // count is the first assertion that the Move really took the row out of this queue.
    const rowsReady = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => n === 3), {
      timeoutMs: 20_000,
      stepMs: 200,
      what: "the three queue rows to paint",
    });
    ok("the pane paints one row per task it still carries", rowsReady, `${await page.locator("#as-queue .as-task").count()} row(s)`);
    if (!rowsReady) {
      // A pane that painted no rows says why somewhere — the error line, the empty-state line, or a page error. Print
      // all three rather than leaving a bare count in the log.
      note(`pane text: ${(await page.locator("#as-queue").innerText()).replace(/\s+/g, " ").slice(0, 700)}`);
      note(`page errors so far: ${JSON.stringify(pageErrors.slice(0, 6))}`);
      note(`failed requests (unique): ${JSON.stringify([...new Set(failedReqs.map((r) => r.split(" — ")[0]).slice(0, 8))])}`);
      note(`queue requests seen: ${JSON.stringify(queueReqs.slice(0, 6))} (${queueReqs.length} total)`);
      const diag = await page.evaluate(async () => {
        const out = {};
        try {
          const r = await apiFetch("/api/assistant/queue?assistantId=assistant-1");
          out.apiFetch = `${r.status} ${(await r.text()).slice(0, 40)}`;
        } catch (e) {
          out.apiFetch = `ERR ${String((e && e.message) || e)}`;
        }
        out.token = localStorage.getItem("wtgui.panelToken");
        out.resources = performance.getEntriesByType("resource").length;
        return out;
      });
      note(`in-page apiFetch probe: ${JSON.stringify(diag)}`);
    }

    const rows = await page.$$eval("#as-queue .as-task", (els) =>
      els.map((el) => ({
        id: el.dataset.asQrow,
        mark: el.querySelector(".as-task-mark")?.textContent.trim() || "",
        markClass: el.querySelector(".as-task-mark")?.className || "",
        title: el.querySelector(".as-task-title")?.textContent.trim() || "",
        owner: el.querySelector(".as-task-owner")?.textContent.trim() || "",
        meta: (el.querySelector(".as-task-meta")?.textContent || "").replace(/\s+/g, " ").trim(),
        note: (el.querySelector(".as-task-note")?.textContent || "").replace(/\s+/g, " ").trim(),
        done: el.classList.contains("is-done"),
        opacity: getComputedStyle(el).opacity,
        hasMove: Boolean(el.querySelector('[data-as-qact="reassign"]')),
        hasDelete: Boolean(el.querySelector('[data-as-qact="delete"]')),
      })),
    );
    // The pane's order is running, queued, parked, done — the table above is built in that order on purpose.
    check("the rows are the three tasks #1 still carries, in state order", rows.map((r) => r.id), ["2", "3", "4"]);
    check("THE THREE MARKERS LEFT: ● running, ⏸ parked, ✓ done", rows.map((r) => r.mark), ["●", "⏸", "✓"]);
    check("…each marker carrying its own state class", rows.map((r) => r.markClass.replace("as-task-mark ", "")), ["is-running", "is-parked", "is-done"]);
    ok("the done row is greyed in place, not removed", rows[2]?.done === true && Number(rows[2]?.opacity) < 1, `opacity ${rows[2]?.opacity}`);
    ok("…and no other row is", rows.slice(0, 2).every((r) => !r.done && Number(r.opacity) === 1), JSON.stringify(rows.map((r) => r.opacity)));
    check("each row shows its id and title", rows.map((r) => r.title), ["rewrite the queue's file claims", "SQL verify for the queue store", "land the per-assistant queue"]);
    ok("the running row names its thread", (rows[0]?.meta || "").includes("thread queue-gate-thread-2"), rows[0]?.meta);
    ok("…says STALE instead of showing phantom progress", /^STALE — that thread has no live run/.test(rows[0]?.note || ""), rows[0]?.note);
    ok("the parked row carries its reason", /^parked — waiting on the DBA's verify$/.test(rows[1]?.note || ""), rows[1]?.note);
    ok("every row names the assistant that carries it", rows.every((r) => r.owner === "assistant-1"), JSON.stringify(rows.map((r) => r.owner)));
    ok("every row offers a delete", rows.every((r) => r.hasDelete));
    ok("every row offers the move control (a second assistant exists)", rows.every((r) => r.hasMove));

    // A read that lands must not start the next one: the pane's own repaint is cache-gated. Before the guard, two
    // paints could supersede each other's read and re-fetch forever (24,588 requests in 20 s).
    const readsBefore = queueReqs.length;
    await page.waitForTimeout(1500);
    const readsAfter = queueReqs.length - readsBefore;
    ok("the pane does not re-read its queue in a loop", readsAfter <= 1, `${readsAfter} read(s) in 1.5 s after the paint`);

    // Move through the pane: choose Assistant #2, press Move, wait for the ROW to leave this queue.
    await page.selectOption('[data-as-qmove="3"]', "assistant-2");
    await page.click('[data-as-qact="reassign"][data-as-qid="3"]');
    const rowLeft = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => n === 2), {
      timeoutMs: 10_000,
      stepMs: 200,
      what: "the moved row to leave this pane",
    });
    ok("pressing Move takes the row out of this assistant's list", rowLeft, `${await page.locator("#as-queue .as-task").count()} row(s) left`);
    ok("…and the row is really gone, not just repainted", (await page.locator('[data-as-qrow="3"]').count()) === 0);
    ok("…the route agrees it left", (await queueOf()).tasks.every((t) => t.id !== 3));
    const inTwo = (await queueOf("assistant-2")).tasks.find((t) => t.title === "SQL verify for the queue store");
    ok("…and Assistant #2 carries it, with the move recorded", Boolean(inTwo) && inTwo.movedFrom?.some((m) => m.from === "assistant-1" && m.to === "assistant-2"), JSON.stringify(inTwo || null));

    // Delete through the pane: press ✕ on the running task and watch its row go.
    await page.click('[data-as-qact="delete"][data-as-qid="2"]');
    const gone = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => n === 1), {
      timeoutMs: 10_000,
      stepMs: 200,
      what: "the row to be removed",
    });
    ok("pressing ✕ removes the row from the pane", gone, `${await page.locator("#as-queue .as-task").count()} row(s) left`);
    ok("…and the row is gone from the store too", (await queueOf()).tasks.every((t) => t.id !== 2));
    const after = await page.$$eval("#as-queue .as-task .as-task-mark", (els) => els.map((el) => el.textContent.trim()));
    check("the remaining marker is the one its state owns", after, ["✓"]);

    await page.screenshot({ path: path.join(dir, "queue-subtab.png") }).catch(() => {});
    check("no page errors", pageErrors, []);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a real panel process booted by tools/panel-testkit.mjs over its own data directory and a");
  console.log("scanned repo (no gateway, no spawned run, the live 7331 listener count identical across the run) — its seeded");
  console.log("queue files for Assistant #1 and a created Assistant #2, the queue route's GET/POST verbs, the digest with");
  console.log("its stale and skipped lines — and headless Chromium over that panel: the third sub-tab, the rows #1 still");
  console.log("carries with ● ⏸ ✓, the greyed done row, the stale thread, and a real Move that leaves the queue plus a ✕.");
  if (!failures) console.log("ASSISTANT-QUEUE-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panel) console.log(`--- panel log (tail)\n${String(panel.log()).split(/\r?\n/).slice(-25).join("\n")}`);
} finally {
  // A browser left open keeps node's loop alive: the run would print everything and then never exit.
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
