// ASSISTANT #2'S OWN CHAT, DRIVEN IN A REAL BROWSER. One sandbox panel of its own (free port, own state directory,
// own scanned repo, its own stub Runs API), Assistant #2 created through the route, and then the reader's own
// gestures on the page:
//
//   node tools/verify-assistant-2-chat.mjs
//
// WHAT THIS GATE EXISTS FOR. A reader could select Assistant #2 — the tab switched, the pane showed, the intro box
// took the text — and pressing "Send to Assistant #2" did NOTHING: no request, no error, no console message. The
// press was swallowed by the alert-reply branch above it in the float's one click handler, which matched the same
// `data-as-send` attribute, found no `[data-as-draft]` box for the assistant's id, read empty text and returned, so
// the intro branch below it was unreachable. The same defect killed Assistant #1's intro box, which is why nobody
// noticed: #1 usually has a card already, and the intro box is only what a thread with no turn shows.
//
// What this gate proves, from `/api/jobs` and from the request the page actually sent — never from the page's own
// claim that it sent something:
//
//   1. THE SANDBOX IS ITS OWN. A free port asserted ≠ 7331, a throwaway state directory, a throwaway scanned repo,
//      a throwaway HERMES_HOME, and the live board's 7331 listener count compared before and after;
//   2. #2'S TAB IS ITS OWN CHAT. Selecting it shows its own pane, its own intro box and its own Send button, and
//      #1's pane is hidden — the two never answer for each other;
//   3. EACH ASSISTANT KEEPS ITS OWN DRAFT. Text typed in #2's box survives a switch to #1 and back, and #1's own
//      text survives the same trip — the panes are separate, so neither box can be the other's;
//   4. #2'S SEND STARTS A RUN ON #2'S THREAD. The request carries `assistantId: assistant-2`, `/api/jobs` holds a
//      job on `panel-assistant-2` stamped `assistant-2`, and the pane turns into that thread's card;
//   5. #1'S CHAT IS UNCHANGED. Its own box still sends on `panel-assistant` stamped `assistant-1`, and #2's thread
//      gains nothing from it;
//   6. A MESSAGE WHILE #2 IS LIVE IS REFUSED WITH THE MESSAGE. A second sandbox panel (so #2's thread is free for
//      the sections above) starts a turn on #2's thread behind a page that cannot see it, and the reader's press
//      comes back as the server's own "still thinking about the last message" in the page's banner — the text stays
//      in the box, and no second job is created.
//
// The live panel on :7331 and the live gateway are never touched: the stub answers on an ephemeral port of its own.
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { freePort, git, startPanel, waitFor } from "./panel-testkit.mjs";
import { openPage, stubEventSourceInit, withBrowser } from "./browser.mjs";

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

// ---- the stub Runs API -------------------------------------------------------------------------------------------
// The gateway's shape, with the one power this gate needs: a run stays "running" until the test says otherwise, so
// "the assistant is still thinking" is a state the gate can hold open rather than a race it hopes to win.
function makeStub() {
  const answers = new Map();
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
      return json(200, { version: "assistant-2-chat-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } }, res);
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
        const timer = setInterval(() => {
          const cur = answers.get(id) || null;
          if (!cur || cur.status === "running") {
            res.write(": hold\n\n");
            return;
          }
          clearInterval(timer);
          timers.delete(timer);
          if (cur.output) res.write(`event: message.delta\ndata: ${JSON.stringify({ event: "message.delta", delta: `\n\n${cur.output}` })}\n\n`);
          res.write(`event: run.${cur.status}\ndata: ${JSON.stringify({ event: `run.${cur.status}`, output: cur.output, usage: cur.usage, exit_code: cur.exit_code })}\n\n`);
          res.end();
        }, 120);
        timers.add(timer);
        req.on("close", () => {
          clearInterval(timer);
          timers.delete(timer);
        });
        return;
      }
      return json(200, { run_id: id, ...(answers.get(id) || { status: "running" }) }, res);
    }
    json(404, { error: { message: "not found" } }, res);
  });
  return {
    seen,
    server,
    set: (id, body) => answers.set(id, body),
    close: () =>
      new Promise((r) => {
        for (const t of timers) clearInterval(t);
        timers.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- HTTP --------------------------------------------------------------------------------------------------------
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

// ---- the sandbox: its own port, its own state directory, its own repo --------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-assistant-2-chat-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "sandbox-repo");
for (const d of [repo, path.join(repo, ".worktrees"), path.join(dir, "hermes-home")]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# the sandbox repo, for Assistant #2's own chat\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "first"]);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

const liveBefore = listenersOn(7331);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

// The panel's own config, shared by both sandboxes: long clocks (this gate drives every change itself), the stub
// gateway, and the sentry at its slowest legal clock so no wake can add a job the assertions did not ask for.
const panelConfig = (root) => ({
  refreshSeconds: 3600,
  worktreeSeconds: 3600,
  midSeconds: 3600,
  dormantSeconds: 3600,
  slowSeconds: 3600,
  fetchSeconds: 3600,
  scanMode: "all",
  threads: 1,
  defaultCwd: root,
  apiServer: { url: stubUrl, key: "sandbox-key" },
  assistant: { enabled: true, autonomy: "draft", seconds: 120, maxWakesPerHour: 20 },
});

const A1 = "assistant-1";
const A2 = "assistant-2";
const T1 = "panel-assistant";
const T2 = "panel-assistant-2";

let panel = null;
let panel2 = null;
const summaries = [];
try {
  panel = await startPanel({ dir, port, config: panelConfig(repo) });
  const jobs = async () => (await getJson(base, "/api/jobs")).jobs || [];
  const jobsOn = async (thread) => (await jobs()).filter((j) => j.thread === thread);
  const assistantState = async () => getJson(base, "/api/assistant");

  // ================================================================================================================
  console.log("\n== 1. a sandbox of its own: own port, own state dir, own scanned repo ==");
  note(`temp root ${dir}`);
  ok("the sandbox port is free of 7331", port !== 7331, `port ${port}`);
  ok("the sandbox config is on disk inside the sandbox", lower(panel.configPath).startsWith(lower(dir)), slash(panel.configPath));
  ok("the scanned repo is the sandbox's own", lower(repo).startsWith(lower(dir)), slash(repo));
  const health = await api(base, "/api/health");
  ok("the sandbox answers on its own port", health.status === 200, `HTTP ${health.status}`);
  await waitFor(
    async () => {
      const s = await getJson(base, "/api/state");
      return (s.projects || []).some((p) => lower(p.path) === lower(repo) || lower(p.name) === "sandbox-repo");
    },
    { what: "the sandbox repo to be discovered", timeoutMs: 45_000 },
  );

  // ================================================================================================================
  console.log("\n== 2. Assistant #2 exists, with its own thread ==");
  const created = await api(base, "/api/assistant/assistants", { method: "POST", body: { name: "Assistant #2" } });
  ok("creating Assistant #2 is accepted", created.status === 201, `HTTP ${created.status} ${created.json?.error || ""}`);
  const records = (await assistantState()).assistants || [];
  check("two assistants are on the board", records.map((a) => a.id), [A1, A2]);
  check("each has its own thread", records.map((a) => a.threadId), [T1, T2]);
  ok("Assistant #2's knobs read enabled", records.find((a) => a.id === A2)?.enabled !== false, JSON.stringify(records.find((a) => a.id === A2)?.enabled));

  // ================================================================================================================
  console.log("\n== 3. the page: #2's tab is its own chat, and each assistant keeps its own draft ==");
  const sent = [];
  await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      page.on("request", (r) => {
        if (r.url().endsWith("/api/assistant/say")) {
          try {
            sent.push(JSON.parse(r.postData() || "{}"));
          } catch {
            sent.push({ unparsed: r.postData() });
          }
        }
      });
      await openPage(page, base, { selector: "section.project, .project" });
      await page.waitForTimeout(1200);
      await page.click("#btn-assistant");
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
      await page.waitForTimeout(600);

      // ---- #2's tab: its own pane, its own box, its own button
      await page.click(`#as-tabs [data-as-tab="${A2}"]`);
      await page.waitForSelector(`#as-chat-2:not(.hidden)`, { timeout: 10_000 });
      const two = await page.evaluate(() => {
        const vis = (el) => Boolean(el) && !el.classList.contains("hidden") && getComputedStyle(el).display !== "none";
        const pane = document.getElementById("as-assistant-2");
        const chat = document.getElementById("as-chat-2");
        const box = document.getElementById("as-first-text-2");
        const btn = document.getElementById("btn-as-first-2");
        return {
          view: JSON.parse(localStorage.getItem("wm.assistantView") || "null"),
          paneVisible: vis(pane),
          chatVisible: vis(chat),
          chatMode: chat?.dataset.mode || null,
          boxVisible: vis(box),
          boxChipKey: box?.dataset.chipbox || null,
          btnVisible: vis(btn),
          btnDisabled: btn?.disabled ?? null,
          btnLabel: btn?.textContent || null,
          onePaneHidden: document.getElementById("as-assistant-1")?.classList.contains("hidden") ?? null,
          onTab: [...document.querySelectorAll("#as-tabs [data-as-tab]")].filter((b) => b.classList.contains("is-on")).map((b) => b.dataset.asTab),
        };
      });
      check("selecting #2 puts its own tab on", two.onTab, [A2]);
      ok("#2's pane is the one on screen", two.paneVisible === true, `pane visible ${two.paneVisible}`);
      ok("#1's pane is hidden while #2 is on", two.onePaneHidden === true, `#1 hidden ${two.onePaneHidden}`);
      ok("#2's chat pane is visible and shows its intro", two.chatVisible === true && two.chatMode === "intro", `visible ${two.chatVisible}, mode ${two.chatMode}`);
      ok("#2 has its own input box", two.boxVisible === true, `#as-first-text-2 visible ${two.boxVisible}`);
      check("#2's box is keyed to #2, not #1", two.boxChipKey, `as-first-${A2}`);
      ok("#2 has its own Send button, enabled", two.btnVisible === true && two.btnDisabled === false, `${two.btnLabel} disabled=${two.btnDisabled}`);

      // ---- each assistant keeps its own draft across a switch
      await page.click("#as-first-text-2");
      await page.keyboard.type("draft for assistant two");
      await page.click(`#as-tabs [data-as-tab="${A1}"]`);
      await page.waitForSelector("#as-chat:not(.hidden)", { timeout: 10_000 });
      await page.click("#as-first-text");
      await page.keyboard.type("draft for assistant one");
      const oneText = await page.evaluate(() => document.getElementById("as-first-text")?.textContent || "");
      check("#1's box holds #1's own draft", oneText, "draft for assistant one");
      await page.click(`#as-tabs [data-as-tab="${A2}"]`);
      await page.waitForSelector("#as-chat-2:not(.hidden)", { timeout: 10_000 });
      const twoText = await page.evaluate(() => document.getElementById("as-first-text-2")?.textContent || "");
      check("#2's box still holds #2's own draft after the switch", twoText, "draft for assistant two");
      await page.click(`#as-tabs [data-as-tab="${A1}"]`);
      await page.waitForSelector("#as-chat:not(.hidden)", { timeout: 10_000 });
      const oneAgain = await page.evaluate(() => document.getElementById("as-first-text")?.textContent || "");
      check("…and #1's box still holds #1's", oneAgain, "draft for assistant one");

      // ---- #2's Send: the press that used to do nothing
      await page.click(`#as-tabs [data-as-tab="${A2}"]`);
      await page.waitForSelector("#as-chat-2:not(.hidden)", { timeout: 10_000 });
      await page.click("#btn-as-first-2");
      const job2 = await waitFor(async () => (await jobsOn(T2))[0] || null, { what: "a job on Assistant #2's thread", timeoutMs: 20_000 });
      ok("pressing #2's Send starts a run", Boolean(job2), job2 ? `${job2.id} ${job2.status}` : "no job on panel-assistant-2");
      check("the request the page sent names Assistant #2", sent[0] || null, { text: "draft for assistant two", assistantId: A2 });
      check("…and the job is on #2's own thread, stamped #2", job2 ? [job2.thread, job2.assistantId] : null, [T2, A2]);
      check("…carrying the text the reader typed", job2?.prompt, "draft for assistant two");
      const card2 = await waitFor(
        async () =>
          page.evaluate(() => {
            const chat = document.getElementById("as-chat-2");
            const card = chat?.querySelector('.job[data-thread="panel-assistant-2"]');
            return chat?.dataset.mode === "card" && card ? { mode: chat.dataset.mode, card: Boolean(card) } : null;
          }),
        { what: "#2's pane to turn into its own thread's card", timeoutMs: 20_000 },
      );
      ok("#2's pane becomes its own thread's card", Boolean(card2), JSON.stringify(card2));

      // ---- #1's chat is unchanged: its own box, its own thread
      await page.click(`#as-tabs [data-as-tab="${A1}"]`);
      await page.waitForSelector("#as-chat:not(.hidden)", { timeout: 10_000 });
      const oneBefore = await page.evaluate(() => document.getElementById("as-first-text")?.textContent || "");
      check("#1's box still holds its draft when #1 is back on", oneBefore, "draft for assistant one");
      await page.click("#btn-as-first");
      const job1 = await waitFor(async () => (await jobsOn(T1))[0] || null, { what: "a job on Assistant #1's thread", timeoutMs: 20_000 });
      ok("pressing #1's Send starts a run", Boolean(job1), job1 ? `${job1.id} ${job1.status}` : "no job on panel-assistant");
      check("the request the page sent names Assistant #1", sent[1] || null, { text: "draft for assistant one", assistantId: A1 });
      check("…and the job is on #1's own thread, stamped #1", job1 ? [job1.thread, job1.assistantId] : null, [T1, A1]);
      check("#2's thread gained nothing from #1's send", (await jobsOn(T2)).length, 1);
      check("no page errors", pageErrors, []);
      check("no console errors", consoleErrors, []);
      summaries.push("#2's tab showed its own chat and input, and its Send started a run on panel-assistant-2 stamped assistant-2");
      summaries.push("each assistant kept its own draft across a switch, and #1's send stayed on panel-assistant");
    },
    { viewport: { width: 1600, height: 1000 } },
  );

  // ================================================================================================================
  console.log("\n== 4. a message sent while #2 is live is refused with the message, not dropped ==");
  // A second sandbox panel, so #2's thread here is free: the page is loaded BEFORE the turn starts and its live
  // stream is stubbed out, which is the reader's real stale-page case — the intro box is still on screen while the
  // server already has a turn running on that thread.
  const dir2 = mkdtempSync(path.join(tmpdir(), "wtgui-assistant-2-live-"));
  const repo2 = path.join(dir2, "repos", "sandbox-repo");
  for (const d of [repo2, path.join(repo2, ".worktrees"), path.join(dir2, "hermes-home")]) mkdirSync(d, { recursive: true });
  git(repo2, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo2, "README.md"), "# the second sandbox, for the live refusal\n", "utf8");
  git(repo2, ["add", "."]);
  git(repo2, ["commit", "-q", "-m", "first"]);
  const port2 = await freePort();
  const base2 = `http://127.0.0.1:${port2}`;
  panel2 = await startPanel({ dir: dir2, port: port2, config: panelConfig(repo2) });
  const created2 = await api(base2, "/api/assistant/assistants", { method: "POST", body: { name: "Assistant #2" } });
  ok("the second sandbox has Assistant #2 too", created2.status === 201, `HTTP ${created2.status}`);
  const jobs2 = async () => (await getJson(base2, "/api/jobs")).jobs || [];
  const jobsOn2 = async (thread) => (await jobs2()).filter((j) => j.thread === thread);

  await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      await openPage(page, base2, { selector: "section.project, .project" });
      await page.waitForTimeout(1200);
      await page.click("#btn-assistant");
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
      await page.click(`#as-tabs [data-as-tab="${A2}"]`);
      await page.waitForSelector("#as-chat-2:not(.hidden)", { timeout: 10_000 });
      const intro = await page.evaluate(() => Boolean(document.getElementById("as-first-text-2")));
      ok("the page shows #2's intro box before any turn exists", intro === true, `box ${intro}`);

      // The turn starts behind the page's back: the stub stream is inert, so the page never learns of it.
      const live = await api(base2, "/api/assistant/say", { method: "POST", body: { text: "a turn the page has not seen", assistantId: A2 } });
      ok("a turn is started on #2's thread behind the page", live.status === 202, `HTTP ${live.status} ${live.json?.error || ""}`);
      check("…and the store holds it on #2's thread", (await jobsOn2(T2)).map((j) => j.assistantId), [A2]);

      await page.click("#as-first-text-2");
      await page.keyboard.type("a second message while it is thinking");
      await page.click("#btn-as-first-2");
      const banner = await waitFor(
        async () =>
          page.evaluate(() => {
            const b = document.getElementById("banner");
            const t = document.getElementById("banner-text");
            const text = String(t?.textContent || b?.textContent || "");
            return b && !b.classList.contains("hidden") && /still thinking about the last message/.test(text) ? text : null;
          }),
        { what: "the refusal to reach the page's banner", timeoutMs: 15_000 },
      );
      ok("the refusal reaches the reader as the server's own message", Boolean(banner), banner || "no banner");
      const kept = await page.evaluate(() => document.getElementById("as-first-text-2")?.textContent || "");
      check("…and the reader's text is still in the box, not dropped", kept, "a second message while it is thinking");
      check("…and no second job was created on #2's thread", (await jobsOn2(T2)).length, 1);
      check("no page errors", pageErrors, []);
      // The 409 is the answer this section ASKS for, and the browser logs every non-2xx response as a console
      // error of its own. Anything else in there is a real defect.
      check("no console errors beyond the 409 this section asks for", consoleErrors.filter((e) => !/409 \(Conflict\)/.test(e)), []);
      summaries.push("a message sent while #2 was live came back as the server's 'still thinking' message, with the text kept");
    },
    { viewport: { width: 1600, height: 1000 }, initScript: stubEventSourceInit },
  );

  // ================================================================================================================
  console.log("\n== 5. the reader's own panel was never touched ==");
  const liveAfter = listenersOn(7331);
  check("the live board's 7331 listener count is unchanged", liveAfter, liveBefore);
  summaries.push("the live :7331 board was untouched before and after");
} catch (err) {
  failures += 1;
  console.log(`FAIL  the run threw: ${String((err && err.stack) || err)}`);
} finally {
  console.log("\n== what this run proved ==");
  for (const s of summaries) console.log(`  · ${s}`);
  for (const p of [panel, panel2]) {
    if (!p) continue;
    try {
      console.log(`      panel log: ${p.log().split("\n").slice(-4).join(" | ")}`);
    } catch {
      /* nothing to say */
    }
    await p.stop();
  }
  await stub.close();
  for (const d of [dir, path.join(tmpdir(), "wtgui-assistant-2-live-")]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* a locked temp file is not this gate's verdict */
    }
  }
  console.log(`\nRESULT: ${failures ? "FAIL" : "PASS"} — ${checks} checks, ${failures} failed`);
  clearTimeout(watchdog);
  process.exit(failures ? 1 : 0);
}
