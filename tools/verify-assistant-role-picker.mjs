// THE SETTINGS ROLE PICKER, ITS RESTART, AND THE ROLE-TAB LINK — driven in a real browser over a sandbox panel.
//
//   node tools/verify-assistant-role-picker.mjs
//
// The brief: a role picker belongs in ONE assistant's Settings sub-tab, writing the choice to that assistant's record
// (the field the Role tab already reads), a Restart that applies it to that assistant's NEXT turn without bouncing the
// panel or the gateway, and a button that lands on the panel-level Role tab. This gate drives exactly that, from the
// reader's gestures, and reads the result from the store and from the run the page's own Send starts — never from the
// page's claim that it did something:
//
//   1. THE PICKER IS ON #2'S SETTINGS, listing the server's role library, showing the role the record carries.
//   2. A PICK SAVES TO #2'S RECORD and says it needs the restart; the state and the assistants file both read the
//      new role, and #1's record is untouched.
//   3. THE SAME ROLE IS SELECTED AFTER A PAGE RELOAD — the persistence half, read from the fresh page.
//   4. THE RESTART SAYS WHAT IT RESTARTED: the row's own line names #2, the Assistant Director role and the three
//      blocks sent in full again, and the journal carries a `role-restart` entry. The panel's listener count on its
//      own port and the stub gateway's request count show neither process was restarted.
//   5. THE NEXT TURN CARRIES THE NEW ROLE: the run the page's Send starts on panel-assistant-2 has an `input` with
//      `role Assistant Director` and the Director's charter in full, not the withheld marker.
//   6. THE LINK LANDS ON THE ROLE TAB, editing #2: `#as-role` is the visible pane, the view persisted as
//      `{assistant:"role"}`, and the pane's own target and picker name #2 and Assistant Director.
//
// Everything happens in a sandbox of its own: a throwaway repo, HERMES_HOME, PANEL_CONFIG with its own port, its own
// logs and job store, and a stub Runs API on an ephemeral port. The live panel on 7331 and the live gateway are never
// touched. The browser half needs a Playwright install; point PANEL_PLAYWRIGHT_ROOT at one. Without one the script
// says BROWSER-HALF-NOT-RUN and exits 2 rather than passing on a half that never ran.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
// The gateway's shape, with the one power this gate needs: a submitted run stays running, and its input is recorded
// BEFORE the answer, so the turn's preamble is what the assertion reads — not the page's, and not the job's display
// prompt (which is deliberately shorter than the input).
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
      return json(200, { version: "assistant-role-picker-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } }, res);
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

// ---- the sandbox: its own port, own state directory, own repo -----------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-role-picker-"));
const repo = path.join(dir, "repos", "sandbox-repo");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "sandbox@example.test"]);
git(repo, ["config", "user.name", "Sandbox"]);
writeFileSync(path.join(repo, "README.md"), "# the sandbox repo, for the Settings role picker\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "first"]);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

const liveBefore = listenersOn(7331);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const panelConfig = {
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
  // Long clocks: this gate drives every change itself, and a sentry pass could start a turn the assertions did not ask
  // for. The assistant is enabled because the next-turn half is a real Send through this panel.
  assistant: { enabled: true, autonomy: "draft", seconds: 120, maxWakesPerHour: 20 },
};

const A1 = "assistant-1";
const A2 = "assistant-2";
const T2 = "panel-assistant-2";

let panel = null;
const summaries = [];
try {
  panel = await startPanel({ dir, port, config: panelConfig });
  const assistantState = async () => getJson(base, "/api/assistant");
  const jobs = async () => (await getJson(base, "/api/jobs")).jobs || [];

  // ================================================================================================================
  console.log("\n== 1. a sandbox of its own, and Assistant #2 on the manager role ==");
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

  const created = await api(base, "/api/assistant/assistants", { method: "POST", body: { name: "Assistant #2" } });
  ok("creating Assistant #2 is accepted", created.status === 201, `HTTP ${created.status} ${created.json?.error || ""}`);
  const seeded = (await assistantState()).assistants || [];
  check("two assistants are on the board", seeded.map((a) => a.id), [A1, A2]);
  const a2Before = seeded.find((a) => a.id === A2);
  check("#2 starts on the manager role", [a2Before?.roleId, a2Before?.roleName], ["agent-manager", "Agent Manager"]);
  const a1Before = seeded.find((a) => a.id === A1);
  const a1RoleBefore = a1Before?.roleId;

  // ================================================================================================================
  console.log("\n== 2. the page: the picker is on #2's Settings, and a pick saves to #2's record ==");
  await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      const openFloat = async () => {
        if (await page.locator("#assistant:not([hidden])").count()) return;
        await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
        await page.waitForTimeout(500);
      };
      const openSettings = async () => {
        await page.click(`#as-tabs [data-as-tab="${A2}"]`);
        await page.click('#as-subtabs [data-as-subtab="settings"]');
        await page.waitForSelector("#as-settings-2:not(.hidden)", { timeout: 10_000 });
        await page.waitForSelector('[data-as-setrole="assistant-2"]', { timeout: 10_000 });
      };
      const roleRow = () =>
        page.evaluate(() => {
          const sel = document.querySelector('[data-as-setrole="assistant-2"]');
          const row = sel?.closest(".as-group") || null;
          const btn = (id) => document.querySelector(`[data-as-${id}="assistant-2"]`);
          return {
            value: sel?.value || null,
            options: [...(sel?.options || [])].map((o) => ({ id: o.value, name: o.textContent.trim() })),
            hint: row?.querySelector("[data-as-rolename]")?.textContent.trim() || "",
            help: row?.innerText || "",
            restart: Boolean(btn("rolerestart")),
            open: Boolean(btn("roleopen")),
            status: row?.querySelector("[data-as-rolestatus]")?.textContent.trim() || "",
            visible: Boolean(sel) && !sel.closest(".hidden") && getComputedStyle(sel).display !== "none",
          };
        });

      await openPage(page, base, { selector: "section.project, .project" });
      await page.waitForTimeout(1200);
      await openFloat();
      await openSettings();

      const row = await roleRow();
      ok("the role row is on #2's Settings", row.visible, `visible ${row.visible}`);
      check("it shows the role #2 runs", row.value, "agent-manager");
      check("…and names it", row.hint, "Agent Manager");
      check(
        "…listing the server's role library",
        row.options.map((o) => o.id),
        ["agent-manager", "assistant-director"],
      );
      ok("…with a Restart role press beside it", row.restart, `restart ${row.restart}`);
      ok("…and a press that opens the Role tab", row.open, `open ${row.open}`);
      ok("…and a help line that says a pick is not an adoption", /charter text stays this assistant's own copy/i.test(row.help));

      // The pick: a real change event, the same one a reader's click produces.
      await page.selectOption('[data-as-setrole="assistant-2"]', "assistant-director");
      const afterPick = await waitFor(
        async () => {
          const r = await roleRow();
          return r.value === "assistant-director" && /Saved/i.test(r.status) ? r : null;
        },
        { what: "the pick to save and say it needs the restart", timeoutMs: 15_000 },
      );
      check("the select now shows the picked role", afterPick.value, "assistant-director");
      ok("the row says it saved and names the restart", /runs the Assistant Director role\. Press Restart role/i.test(afterPick.status), afterPick.status);
      const stateAfterPick = await assistantState();
      check(
        "#2's record now carries the Director role",
        [stateAfterPick.assistants.find((a) => a.id === A2)?.roleId, stateAfterPick.assistants.find((a) => a.id === A2)?.roleName],
        ["assistant-director", "Assistant Director"],
      );
      check("…and #1's record is untouched", stateAfterPick.assistants.find((a) => a.id === A1)?.roleId, a1RoleBefore);

      // ==============================================================================================================
      console.log("\n== 3. the same role is selected after a page reload ==");
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector("section.project, .project", { timeout: 30_000 });
      await page.waitForTimeout(1500);
      await openFloat();
      await openSettings();
      const afterReload = await waitFor(
        async () => {
          const r = await roleRow();
          return r.value === "assistant-director" ? r : null;
        },
        { what: "the fresh page to read the stored role", timeoutMs: 15_000 },
      );
      check("a reload still reads Assistant Director", afterReload.value, "assistant-director");
      check("…and the row's heading names it", afterReload.hint, "Assistant Director");

      // ==============================================================================================================
      console.log("\n== 4. Restart rebuilds #2's next turn and says what it restarted ==");
      const runningBefore = (await jobs()).filter((j) => j.thread === T2).length;
      await page.click('[data-as-rolerestart="assistant-2"]');
      const afterRestart = await waitFor(
        async () => {
          const r = await roleRow();
          return /Restarted .*turn context/i.test(r.status) ? r : null;
        },
        { what: "the restart's own account in the row", timeoutMs: 15_000 },
      );
      ok("the row says it restarted #2's turn context", /Restarted Assistant #2's turn context/i.test(afterRestart.status), afterRestart.status);
      ok("…the role the next turn is built from", /built from the Assistant Director role/i.test(afterRestart.status), afterRestart.status);
      ok("…what was sent in full again", /the .*go in full again|Nothing had been sent yet this session/i.test(afterRestart.status), afterRestart.status);
      ok("…and that the panel and gateway were not", /The panel and the gateway were not restarted/i.test(afterRestart.status), afterRestart.status);
      const stateAfterRestart = await assistantState();
      const restartEntry = (stateAfterRestart.journal || []).find((x) => x.kind === "role-restart" && /Assistant Director/.test(x.text));
      ok("the journal carries the restart", Boolean(restartEntry), restartEntry ? restartEntry.text : "no role-restart entry");
      ok("the restart started no run of its own", (await jobs()).filter((j) => j.thread === T2).length === runningBefore, `jobs on ${T2}: ${runningBefore}`);
      check("the panel is still the same listener on its own port", listenersOn(port), 1);

      // ==============================================================================================================
      console.log("\n== 5. the next turn the page sends carries the new role ==");
      await page.click(`#as-subtabs [data-as-subtab="chat"]`);
      await page.waitForTimeout(300);
      await page.click("#as-first-text-2");
      await page.keyboard.type("show me the role this turn runs");
      await page.click("#btn-as-first-2");
      const submitted = await waitFor(async () => (stub.seen.submitted.find((s) => s.session_id === T2) || null), {
        what: "the run the page started on #2's thread",
        timeoutMs: 25_000,
      });
      ok("a run reached the gateway on #2's thread", Boolean(submitted), submitted ? `${submitted.session_id}` : "nothing submitted");
      ok("the turn's input names the new role", /role Assistant Director/.test(submitted?.input || ""), String(submitted?.input || "").slice(0, 300));
      ok("…and carries the Director charter in full", /Charter — the long tier, read in full this turn \(role Assistant Director;/.test(submitted?.input || ""));
      ok("…not the withheld marker", !/unchanged and withheld this turn/.test(submitted?.input || ""));
      ok("…and the Director's own job is in it", /You direct the other assistants/.test(submitted?.input || ""));
      ok("…while the reader's words are the card's prompt", /show me the role this turn runs/.test(submitted?.input || ""));

      // A SECOND restart, now that a turn has actually been built: the cleared list is no longer empty, and the line
      // names the blocks that go in full again — the branch a reader sees on a working assistant.
      await page.click(`#as-subtabs [data-as-subtab="settings"]`);
      await page.waitForSelector('[data-as-setrole="assistant-2"]', { timeout: 10_000 });
      await page.click('[data-as-rolerestart="assistant-2"]');
      const restartAgain = await waitFor(
        async () => {
          const r = await roleRow();
          return /go in full again/i.test(r.status) ? r : null;
        },
        { what: "the restart to name the blocks it cleared", timeoutMs: 15_000 },
      );
      ok("a restart after a turn names the charter it cleared", /the charter/i.test(restartAgain.status), restartAgain.status);
      ok("…and the board digest", /the board/i.test(restartAgain.status), restartAgain.status);
      ok("…and is still honest about the running turn", /a turn was already running; the rebuild is its next one/i.test(restartAgain.status), restartAgain.status);

      // ==============================================================================================================
      console.log("\n== 6. the Role-tab press lands on the Role tab, editing #2 ==");
      await page.click('[data-as-roleopen="assistant-2"]');
      await page.waitForSelector("#as-role:not(.hidden)", { timeout: 10_000 });
      await waitFor(() => page.evaluate(() => !document.querySelector("#as-role-text")?.readOnly), {
        what: "the Role tab to read #2's charter",
        timeoutMs: 15_000,
      });
      const onRole = await page.evaluate(() => ({
        roleVisible: !document.getElementById("as-role")?.classList.contains("hidden"),
        subRowGone: !document.getElementById("as-subtabs") || getComputedStyle(document.getElementById("as-subtabs")).display === "none",
        view: JSON.parse(localStorage.getItem("wm.assistantView") || "null"),
        target: document.getElementById("as-roletarget")?.value || null,
        pick: document.getElementById("as-role-pick")?.value || null,
      }));
      ok("the panel-level Role pane is the one showing", onRole.roleVisible, `visible ${onRole.roleVisible}`);
      ok("…with the session's second row gone", onRole.subRowGone);
      check("…the view persisted as the Role tab", onRole.view?.assistant, "role");
      check("…editing the assistant whose Settings was on screen", onRole.target, A2);
      check("…with its role picker on the role it runs", onRole.pick, "assistant-director");

      check("no page errors", pageErrors, []);
      check("no console errors", consoleErrors, []);
      summaries.push("the Settings picker saved Assistant Director on #2's record and a reload read it back");
      summaries.push("Restart rebuilt #2's next turn from the Director role and named what it rebuilt, with no panel or gateway restart");
      summaries.push("the next run's input carried the Director charter in full, and the Role-tab press landed on #2's Role pane");
    },
    { viewport: { width: 1600, height: 1000 }, initScript: stubEventSourceInit },
  );

  ok("the live panel on 7331 was not touched", listenersOn(7331) === liveBefore, `before ${liveBefore}, after ${listenersOn(7331)}`);
} catch (err) {
  failures += 1;
  console.log(`FAIL  the gate threw: ${String((err && err.stack) || err)}`);
} finally {
  try {
    await panel?.stop();
  } catch {
    /* already down */
  }
  await stub.close().catch(() => {});
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file for a moment */
  }
  clearTimeout(watchdog);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
for (const s of summaries) console.log(`  · ${s}`);
if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nOK — the Settings role picker, its restart and the Role-tab link all behaved");
