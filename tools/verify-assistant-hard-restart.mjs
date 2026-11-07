// THE HARD RESTART, DRIVEN IN A REAL BROWSER. One sandbox panel of its own (free port, own state directory, own
// scanned repo, its own stub Runs API), Assistant #2 created through the route, and then the reader's own gestures on
// Assistant #1's Settings sub-pane:
//
//   node tools/verify-assistant-hard-restart.mjs
//
// What this gate exists for, and what nothing below the page can see:
//
//   1. THE CONTROL IS WHERE IT WAS ASKED FOR — in the per-assistant Settings sub-pane (its tab → Settings), and
//      nowhere else on the page. At rest it is ONE button.
//   2. THE FIRST PRESS DOES NOTHING BUT ARM. The page's own request log must stay empty, `/api/assistant` must still
//      report the same thread, and `/api/jobs` must not move; what the press buys is the Cancel / "Are you sure?"
//      pair on screen.
//   3. CANCEL PUTS IT BACK and still sends nothing.
//   4. THE SECOND PRESS PERFORMS EXACTLY ONE RESTART — one POST, one record, one new thread — for THAT assistant.
//      The other assistant's thread id and jobs are read back unchanged, and the row says the panel and the gateway
//      were not restarted.
//   5. THE NEW THREAD IS A NEW SESSION, not a rename: the next message the reader sends from that assistant's Chat is
//      posted to the stub gateway with `session_id` equal to the NEW thread, and that thread had no turns before it.
//   6. A SECOND ARM + CONFIRM IS A SECOND RESTART, one POST each — the control is repeatable and never fires twice on
//      one press.
//
// The live panel on :7331 and the live gateway are never touched: the stub answers on an ephemeral port of its own.
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { freePort, git, startPanel, waitFor } from "./panel-testkit.mjs";
import { loadPlaywright, notRun, openPage, stubEventSourceInit, withBrowser } from "./browser.mjs";

// A gate that cannot open the page must SAY so and fail, never pass on a half that never ran.
const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("the hard restart's two presses were not exercised in a browser", "no Playwright install was found"));
  console.log("  re-run with PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-assistant-hard-restart.mjs");
  process.exit(2);
}

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing — see the last line above.\n`);
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
  return pass;
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
  return Boolean(cond);
};
const note = (text) => console.log(`      ${text}`);
const slash = (p) => String(p || "").replace(/\\/g, "/");
const lower = (p) => slash(p).replace(/\/+$/, "").toLowerCase();
const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

// ---- the stub Runs API: it records every /v1/runs body and holds the run open -------------------------------------
function makeStub() {
  const seen = { submitted: [] };
  const timers = new Set();
  const json = (code, body, res) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "hard-restart-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } }, res);
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      const body = await readBody(req);
      seen.submitted.push({ ...body, at: Date.now() });
      return json(200, { run_id: `stub-run-${seen.submitted.length}`, status: "running" }, res);
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      if (sub === "/steer") {
        await readBody(req);
        return json(200, { accepted: true, run_id: id }, res);
      }
      if (sub === "/stop") return json(200, { ok: true }, res);
      if (sub === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const timer = setInterval(() => res.write(": hold\n\n"), 1500);
        timers.add(timer);
        req.on("close", () => {
          clearInterval(timer);
          timers.delete(timer);
        });
        return;
      }
      return json(200, { run_id: id, status: "running" }, res);
    }
    json(404, { error: { message: "not found" } }, res);
  });
  return {
    seen,
    server,
    close: () =>
      new Promise((r) => {
        for (const t of timers) clearInterval(t);
        timers.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- HTTP ---------------------------------------------------------------------------------------------------------
async function api(base, route, { method = "GET", body = null } = {}) {
  const r = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text };
}
const getJson = async (base, route) => (await api(base, route)).json;

// ---- the sandbox --------------------------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-hard-restart-ui-"));
const repo = path.join(dir, "repos", "sandbox-repo");
for (const d of [repo, path.join(repo, ".worktrees"), path.join(dir, "hermes-home")]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# the sandbox repo, for the hard restart\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "first"]);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

const liveBefore = listenersOn(7331);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const A1 = "assistant-1";
const A2 = "assistant-2";
const T1 = "panel-assistant";

let panel = null;
try {
  panel = await startPanel({
    dir,
    port,
    config: {
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: 3600,
      scanMode: "all",
      threads: 1,
      defaultCwd: repo,
      apiServer: { url: stubUrl, key: "sandbox-key" },
      assistant: { enabled: true, autonomy: "draft", seconds: 120, maxWakesPerHour: 20 },
    },
  });
  const assistantState = async () => getJson(base, "/api/assistant");
  const jobs = async () => (await getJson(base, "/api/jobs")).jobs || [];
  const threadOf = async (id) => (await assistantState()).assistants.find((a) => a.id === id)?.threadId || null;

  // ================================================================================================================
  console.log("\n== 1. a sandbox of its own, and the assistant it will restart ==");
  note(`temp root ${dir}`);
  ok("the sandbox port is free of 7331", port !== 7331, `port ${port}`);
  ok("the sandbox config is on disk inside the sandbox", lower(panel.configPath).startsWith(lower(dir)), slash(panel.configPath));
  check("the live board's 7331 listener count did not change", listenersOn(7331), liveBefore);
  const created = await api(base, "/api/assistant/assistants", { method: "POST", body: { name: "Assistant #2" } });
  ok("creating Assistant #2 is accepted", created.status === 201, `HTTP ${created.status} ${created.json?.error || ""}`);
  const T2 = (await assistantState()).assistants.find((a) => a.id === A2)?.threadId;
  check("#1 runs on its own thread and #2 on another", [(await threadOf(A1)), T2], [T1, "panel-assistant-2"]);

  // ================================================================================================================
  console.log("\n== 2. the control: in this assistant's Settings, one button at rest, nothing on the first press ==");
  const posts = [];
  await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      page.on("request", (r) => {
        if (r.url().endsWith("/api/assistant/hard-restart")) {
          try {
            posts.push(JSON.parse(r.postData() || "{}"));
          } catch {
            posts.push({ unparsed: r.postData() });
          }
        }
      });
      await openPage(page, base, { selector: "#btn-assistant" });
      await page.waitForTimeout(1200);
      await page.click("#btn-assistant");
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
      await page.click(`#as-tabs [data-as-tab="${A1}"]`);
      await page.click('#as-subtabs [data-as-subtab="settings"]');
      await page.waitForSelector(`#as-settings [data-as-hardrestart="${A1}"]`, { timeout: 10_000 });

      const at = async () =>
        page.evaluate(
          ({ a1, a2 }) => {
            const pane = document.getElementById("as-settings");
            const vis = (el) => Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
            const btn = (sel) => pane?.querySelector(sel) || null;
            return {
              // The control exists in the per-assistant Settings sub-pane and nowhere else on the page.
              inSettingsPane: Boolean(pane?.querySelector(`[data-as-hardrestart="${a1}"]`)),
              allControls: [...document.querySelectorAll("[data-as-hardrestart]")].map((b) => b.dataset.asHardrestart),
              restLabel: btn(`[data-as-hardrestart="${a1}"]`)?.textContent?.trim() || null,
              restShown: vis(btn(`[data-as-hardrestart="${a1}"]`)),
              cancelShown: vis(btn(`[data-as-hardrestart-cancel="${a1}"]`)),
              goShown: vis(btn(`[data-as-hardrestart-go="${a1}"]`)),
              goLabel: btn(`[data-as-hardrestart-go="${a1}"]`)?.textContent?.trim() || null,
              note: pane?.querySelector("[data-as-hardrestart-note]")?.textContent?.trim() || "",
              help: pane?.querySelector("[data-as-hardrestart-group] .as-help")?.textContent?.replace(/\s+/g, " ").trim() || "",
              otherPaneControl: Boolean(document.querySelector(`#as-settings-2 [data-as-hardrestart="${a2}"]`)),
            };
          },
          { a1: A1, a2: A2 },
        );

      const rest = await at();
      check("the Hard restart control is in the per-assistant Settings pane", [rest.inSettingsPane, rest.allControls], [true, [A1]]);
      ok("it is a single button at rest", rest.restShown === true && rest.cancelShown === false && rest.goShown === false, `shown ${rest.restShown} cancel ${rest.cancelShown} go ${rest.goShown}`);
      check("its label is the one the brief names", rest.restLabel, "Hard restart");
      check("its note names the thread it is on", rest.note, `thread ${T1}`);
      ok("the copy says the panel and the gateway are NOT restarted", /not\s+restarted/.test(rest.help) && /gateway/.test(rest.help) && /panel/i.test(rest.help), rest.help.slice(0, 220));
      ok("…and that no other assistant's thread is touched", /no other assistant's thread is touched/.test(rest.help), rest.help.slice(-120));

      // ---- ONE PRESS: it arms, and it must not act.
      const jobsBefore = (await jobs()).length;
      await page.click(`#as-settings [data-as-hardrestart="${A1}"]`);
      await page.waitForSelector(`#as-settings [data-as-hardrestart-go="${A1}"]:not([hidden])`, { timeout: 10_000 });
      await page.waitForTimeout(700);
      const armed = await at();
      check("the first press posted nothing", posts, []);
      check("…and the assistant's thread did not move", await threadOf(A1), T1);
      check("…and no job was created", (await jobs()).length, jobsBefore);
      ok("the first press reveals the Cancel / Are you sure pair", armed.cancelShown === true && armed.goShown === true, `cancel ${armed.cancelShown} go ${armed.goShown}`);
      check("the confirm carries the question", armed.goLabel, "Are you sure? Start a fresh thread");
      check("…and the single button is put away", armed.restShown, false);

      // ---- CANCEL: back to rest, still nothing sent.
      await page.click(`#as-settings [data-as-hardrestart-cancel="${A1}"]`);
      await page.waitForSelector(`#as-settings [data-as-hardrestart="${A1}"]:not([hidden])`, { timeout: 10_000 });
      await page.waitForTimeout(500);
      const disarmed = await at();
      ok("cancel puts the single button back", disarmed.restShown === true && disarmed.cancelShown === false && disarmed.goShown === false, `shown ${disarmed.restShown} cancel ${disarmed.cancelShown} go ${disarmed.goShown}`);
      check("cancel posted nothing", posts, []);
      check("cancel left the thread where it was", await threadOf(A1), T1);

      // ---- THE SECOND PRESS: exactly one restart, for this assistant only.
      const t2Before = await threadOf(A2);
      const jobs2Before = (await jobs()).filter((j) => j.thread === t2Before).length;
      await page.click(`#as-settings [data-as-hardrestart="${A1}"]`);
      await page.waitForSelector(`#as-settings [data-as-hardrestart-go="${A1}"]:not([hidden])`, { timeout: 10_000 });
      await page.click(`#as-settings [data-as-hardrestart-go="${A1}"]`);
      const moved = await waitFor(async () => ((await threadOf(A1)) !== T1 ? await threadOf(A1) : null), { what: "Assistant #1's record to move to a new thread", timeoutMs: 20_000 });
      ok("the confirm moved Assistant #1 to a new thread", Boolean(moved), String(moved));
      check("exactly ONE hard-restart request was sent, naming #1", posts, [{ assistantId: A1 }]);
      check("the new thread is a generation of the old one", moved, `${T1}-r2`);
      check("Assistant #2's thread is untouched", await threadOf(A2), t2Before);
      check("…and #2 has no new job", (await jobs()).filter((j) => j.thread === t2Before).length, jobs2Before);
      const roster = (await assistantState()).assistants;
      check("#1's record remembers the thread it left", roster.find((a) => a.id === A1)?.previousThreads, [T1]);

      const done = await at();
      ok("the row reports the restart, and that nothing else was restarted", /Hard restarted Assistant #1/.test(done.note) && /not restarted/.test(done.note), done.note);
      ok("the pair is disarmed again after the restart", done.restShown === true && done.cancelShown === false && done.goShown === false, `shown ${done.restShown}`);
      check("the row now names the NEW thread", /panel-assistant-r2/.test(done.help), true);

      // ---- REPEATABLE: a second arm + confirm is a second restart, one POST each.
      await page.click(`#as-settings [data-as-hardrestart="${A1}"]`);
      await page.waitForSelector(`#as-settings [data-as-hardrestart-go="${A1}"]:not([hidden])`, { timeout: 10_000 });
      await page.click(`#as-settings [data-as-hardrestart-go="${A1}"]`);
      const movedAgain = await waitFor(async () => ((await threadOf(A1)) !== moved ? await threadOf(A1) : null), { what: "a second restart", timeoutMs: 20_000 });
      check("a second confirm moved it on again", movedAgain, `${T1}-r3`);
      check("two confirms, two requests — one per press", posts, [{ assistantId: A1 }, { assistantId: A1 }]);
      check("Assistant #2 is still where it was", await threadOf(A2), t2Before);

      // ==============================================================================================================
      console.log("\n== 3. the new thread is a NEW SESSION: its Chat is empty, and the next message posts to it ==");
      await page.click('#as-subtabs [data-as-subtab="chat"]');
      await page.waitForSelector("#as-chat:not(.hidden)", { timeout: 10_000 });
      const chat = await page.evaluate(() => ({ mode: document.getElementById("as-chat")?.dataset.mode || null, hasCard: Boolean(document.querySelector('#as-chat .job')) }));
      check("its Chat went back to the intro — the new thread has no turns", chat, { mode: "intro", hasCard: false });

      await page.click("#as-first-text");
      await page.keyboard.type("first words on the fresh thread");
      await page.click("#btn-as-first");
      const submitted = await waitFor(async () => stub.seen.submitted.at(-1) || null, { what: "the gateway request", timeoutMs: 20_000 });
      check("the next message is posted on the NEW session id", submitted?.session_id, `${T1}-r3`);
      const jobNew = (await jobs()).find((j) => j.thread === `${T1}-r3`);
      ok("the panel's own store holds that turn on the new thread", Boolean(jobNew), jobNew ? `${jobNew.id} ${jobNew.status}` : "no job");
      check("…as a FIRST turn of that session, not a continuation", jobNew?.reply, false);
      check("…and nothing was started on the threads it left", (await jobs()).filter((j) => j.thread === T1 || j.thread === `${T1}-r2`).length, 0);

      check("no page errors", pageErrors, []);
      check("no console errors", consoleErrors, []);
    },
    { viewport: { width: 1600, height: 1000 }, initScript: stubEventSourceInit },
  );

  check("the live board's 7331 listener count is still unchanged", listenersOn(7331), liveBefore);
} finally {
  clearTimeout(watchdog);
  await panel?.stop().catch(() => {});
  await stub.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}
console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nHARD-RESTART-VERIFY-OK");
process.exit(failures ? 1 : 0);
