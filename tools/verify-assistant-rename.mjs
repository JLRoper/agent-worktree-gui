// ONE ASSISTANT'S NAME, RENAMED FROM ITS OWN SETTINGS — driven in a real browser over a sandbox panel.
//
//   node tools/verify-assistant-rename.mjs
//
// The brief: a rename control in that assistant's Settings (a text input seeded with the current name, a Save, a Cancel
// that puts the old name back), a write that persists the name on the assistant's RECORD through the store the other
// settings already use, and a tab label — plus the float's header — that repaint from the new name with no page reload.
// The id stays `assistant-N`: a rename must not move the queue, the thread, the charter path or the state directory; the
// input is trimmed, empty is refused with a visible message, the name is capped at 40, and duplicates are allowed. This
// gate drives exactly that from the reader's gestures and reads the result from the store and the files, never from the
// page's claim that it did something:
//
//   1. THE CONTROL IS ON #3'S SETTINGS, seeded with "Assistant #3", beside a Save and a Cancel.
//   2. A SAVE RENAMES THE TAB AND THE FLOAT'S HEADER WITH NO RELOAD — the page's own marker survives the write.
//   3. THE RECORD CARRIES IT: `/api/assistant` and the assistants file read the new name, the id is still assistant-3.
//   4. NOTHING ELSE MOVED: the queue file's bytes, its rows, the charter path and the charter's bytes are unchanged.
//   5. A RELOAD READS THE NEW NAME BACK, on the tab, the header and the input.
//   6. EMPTY IS REFUSED WITH A LINE, and Cancel puts the stored name back in the box without writing.
//   7. RENAMED BACK, and a second reload proves the original name is the stored one again.
//
// Everything happens in a sandbox of its own: a throwaway repo, its own port, config, logs and job store. The live panel
// on 7331 is never touched. The browser half needs a Playwright install; without one the script says
// BROWSER-HALF-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-rename-gate-"));
const repo = path.join(dir, "repos", "sandbox-repo");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "sandbox@example.test"]);
git(repo, ["config", "user.name", "Sandbox"]);
writeFileSync(path.join(repo, "README.md"), "# the sandbox repo, for the Settings rename\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "first"]);

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
  // No gateway is needed: this gate never starts a turn, and a long clock keeps the sentry from starting one either.
  assistant: { enabled: false, autonomy: "draft", seconds: 360, maxWakesPerHour: 1 },
};

const A3 = "assistant-3";
const NAME = "Night Watch";
const summaries = [];

let panel = null;
try {
  panel = await startPanel({ dir, port, config: panelConfig });
  const assistantState = async () => getJson(base, "/api/assistant");
  const queueOf = async (id) => (await getJson(base, `/api/assistant/queue?assistantId=${id}`)).queue;

  // ================================================================================================================
  console.log("\n== 1. a sandbox of its own, three assistants, and a queue on #3 ==");
  note(`temp root ${dir}`);
  ok("the sandbox port is free of 7331", port !== 7331, `port ${port}`);
  ok("the sandbox config is on disk inside the sandbox", lower(panel.configPath).startsWith(lower(dir)), slash(panel.configPath));
  const health = await api(base, "/api/health");
  ok("the sandbox answers on its own port", health.status === 200, `HTTP ${health.status}`);
  await waitFor(
    async () => {
      const s = await getJson(base, "/api/state");
      return (s.projects || []).some((p) => lower(p.path) === lower(repo) || lower(p.name) === "sandbox-repo");
    },
    { what: "the sandbox repo to be discovered", timeoutMs: 45_000 },
  );

  for (const n of [2, 3]) {
    const made = await api(base, "/api/assistant/assistants", { method: "POST", body: { roleId: "agent-manager" } });
    ok(`creating Assistant #${n} is accepted`, made.status === 201, `HTTP ${made.status} ${made.json?.error || ""}`);
  }
  const seeded = (await assistantState()).assistants || [];
  check("three assistants are on the board", seeded.map((a) => a.id), ["assistant-1", "assistant-2", A3]);
  check("#3 starts with the derived name", seeded.find((a) => a.id === A3)?.name, "Assistant #3");

  for (const title of ["carry the docs pass", "watch the deploy"]) {
    const added = await api(base, "/api/assistant/queue", { method: "POST", body: { assistantId: A3, action: "add", title } });
    ok(`a queue row for #3 is accepted ("${title}")`, added.status === 200, `HTTP ${added.status} ${added.json?.error || ""}`);
  }
  const queueBefore = await queueOf(A3);
  check("two rows are in #3's queue", queueBefore.tasks.map((t) => t.title), ["carry the docs pass", "watch the deploy"]);
  const queueFile = queueBefore.file;
  const queueBytesBefore = readFileSync(queueFile, "utf8");
  const charterPath = seeded.find((a) => a.id === A3)?.charter?.path || "";
  ok("the charter path was read for #3", Boolean(charterPath), slash(charterPath));
  const charterBytesBefore = readFileSync(charterPath, "utf8");

  // ================================================================================================================
  console.log("\n== 2. the page: the control is on #3's Settings, and a Save moves the tab with no reload ==");
  await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      const openFloat = async () => {
        if (await page.locator("#assistant:not([hidden])").count()) return;
        await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
        await page.waitForTimeout(400);
      };
      const openSettings = async () => {
        await page.click(`#as-tabs [data-as-tab="${A3}"]`);
        await page.click('#as-subtabs [data-as-subtab="settings"]');
        await page.waitForSelector("#as-settings-3:not(.hidden)", { timeout: 10_000 });
        await page.waitForSelector(`[data-as-namesave="${A3}"]`, { timeout: 10_000 });
      };
      const renameRow = () =>
        page.evaluate((id) => {
          const n = String(id).replace(/^assistant-/, "");
          const box = document.getElementById(`as-name-text-${n}`);
          const group = document.getElementById(`as-rename-${n}`);
          const tab = document.querySelector(`#as-tabs [data-as-tab="${id}"]`);
          const head = document.getElementById("as-name");
          return {
            tab: tab ? tab.innerText.trim() : null,
            tabTitle: tab ? tab.title : null,
            head: head ? head.textContent.trim() : null,
            value: box ? box.value : null,
            maxlength: box ? box.maxLength : null,
            save: Boolean(document.querySelector(`[data-as-namesave="${id}"]`)),
            cancel: Boolean(document.querySelector(`[data-as-namecancel="${id}"]`)),
            note: group?.querySelector(`[data-as-namestatus="${id}"]`)?.textContent.trim() || "",
            err: document.getElementById(`as-name-err-${n}`)?.textContent.trim() || "",
            help: group?.innerText || "",
            visible: Boolean(box) && !box.closest(".hidden") && getComputedStyle(box).display !== "none",
            marker: window.__renameMark || null,
          };
        }, A3);
      const tabLabel = () => page.evaluate((id) => document.querySelector(`#as-tabs [data-as-tab="${id}"]`)?.innerText.trim() ?? null, A3);

      await openPage(page, base, { selector: "section.project, .project" });
      await page.waitForTimeout(1200);
      await openFloat();
      await openSettings();

      const row = await renameRow();
      ok("the rename row is on #3's Settings", row.visible, `visible ${row.visible}`);
      // The row is the deliverable's layout proof: 340 px of rail, an input and two buttons, and the assertions above
      // cannot see a label that wrapped to three lines. .shots/ is gitignored, so the tree stays clean.
      const shot = path.join(process.cwd(), ".shots", "assistant-rename-row.png");
      mkdirSync(path.dirname(shot), { recursive: true });
      await page.locator("#as-rename-3").screenshot({ path: shot });
      note(`row screenshot ${slash(shot)}`);
      check("…seeded with the current name", row.value, "Assistant #3");
      ok("…with a Save and a Cancel", row.save && row.cancel, `save ${row.save} cancel ${row.cancel}`);
      check("…and the input capped at 40", row.maxlength, 40);
      ok("…help naming the id that does not move", /id\b.*assistant-3|stays\s+assistant-3/is.test(row.help.replace(/\s+/g, " ")), row.help.split("\n")[1] || row.help);
      check("the tab reads Assistant #3 before the rename", row.tab, "Assistant #3");
      check("the float's header agrees before the rename", row.head, "Assistant #3");

      // The no-reload proof: a marker set on the page now is gone after any navigation.
      await page.evaluate(() => {
        window.__renameMark = "kept";
      });
      await page.fill(`#as-name-text-3`, `  ${NAME}  `);
      await page.click(`[data-as-namesave="${A3}"]`);
      const afterSave = await waitFor(
        async () => {
          const r = await renameRow();
          return r.tab === NAME ? r : null;
        },
        { what: "the tab label to repaint from the saved name", timeoutMs: 15_000 },
      );
      check("the tab label is the new name", afterSave.tab, NAME);
      check("…with the same name in its tooltip", afterSave.tabTitle?.startsWith(NAME), true);
      check("the float's header agrees", afterSave.head, NAME);
      check("…the page was NOT reloaded (its own marker survived)", afterSave.marker, "kept");
      check("the stored input is the trimmed name", afterSave.value, NAME);
      ok("the row says it saved", /Saved/i.test(afterSave.note) && afterSave.note.includes(NAME), afterSave.note);
      check("no refusal line on a good save", afterSave.err, "");
      await page.locator("#as-rename-3").screenshot({ path: path.join(process.cwd(), ".shots", "assistant-rename-saved.png") });

      // ==============================================================================================================
      console.log("\n== 3. the record carries it, and nothing else moved ==");
      const stateAfter = await assistantState();
      const a3 = stateAfter.assistants.find((a) => a.id === A3);
      check("the record's name is the new one", a3?.name, NAME);
      check("the id is still assistant-3", a3?.id, A3);
      check("the thread did not move", a3?.threadId, "panel-assistant-3");
      const onDisk = JSON.parse(readFileSync(path.join(dir, "logs", "assistants.json"), "utf8"));
      check("the assistants file carries it", onDisk.assistants.find((a) => a.id === A3)?.name, NAME);
      const queueAfter = await queueOf(A3);
      check("the queue path did not move", queueAfter.file, queueFile);
      check("the queue rows are unchanged", queueAfter.tasks.map((t) => t.title), ["carry the docs pass", "watch the deploy"]);
      ok("the queue file's bytes are unchanged", readFileSync(queueFile, "utf8") === queueBytesBefore);
      check("the charter path did not move", a3?.charter?.path, charterPath);
      ok("the charter's bytes are unchanged", readFileSync(charterPath, "utf8") === charterBytesBefore);

      // ==============================================================================================================
      console.log("\n== 4. empty is refused with a line, and Cancel puts the stored name back ==");
      await page.fill(`#as-name-text-3`, "   ");
      await page.click(`[data-as-namesave="${A3}"]`);
      const refused = await waitFor(
        async () => {
          const r = await renameRow();
          return r.err ? r : null;
        },
        { what: "the visible refusal for an empty name", timeoutMs: 10_000 },
      );
      ok("the empty name draws a visible sentence", /cannot be empty/i.test(refused.err), refused.err);
      check("…and the tab label did not move", refused.tab, NAME);
      check("…the record did not move either", (await assistantState()).assistants.find((a) => a.id === A3)?.name, NAME);

      await page.fill(`#as-name-text-3`, "Something Else");
      await page.click(`[data-as-namecancel="${A3}"]`);
      const cancelled = await renameRow();
      check("Cancel puts the stored name back in the box", cancelled.value, NAME);
      check("…and clears the refusal", cancelled.err, "");
      check("…without writing the record", (await assistantState()).assistants.find((a) => a.id === A3)?.name, NAME);

      // ==============================================================================================================
      console.log("\n== 5. a reload reads the new name back on the tab, the header and the input ==");
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector("section.project, .project", { timeout: 30_000 });
      // The panel remembers the float open, so pressing #btn-assistant here would CLOSE it.
      await page.waitForSelector("#assistant", { state: "visible", timeout: 20_000 });
      await page.waitForTimeout(800);
      await openFloat();
      await openSettings();
      const afterReload = await waitFor(
        async () => {
          const r = await renameRow();
          return r.value === NAME ? r : null;
        },
        { what: "the fresh page to read the stored name", timeoutMs: 15_000 },
      );
      check("the tab still reads the new name", afterReload.tab, NAME);
      check("the header still reads it", afterReload.head, NAME);
      check("the input is seeded with it", afterReload.value, NAME);

      // ==============================================================================================================
      console.log("\n== 6. renamed back, and a reload proves the original name is stored ==");
      await page.fill(`#as-name-text-3`, "Assistant #3");
      await page.click(`[data-as-namesave="${A3}"]`);
      await waitFor(
        async () => {
          const r = await renameRow();
          return r.tab === "Assistant #3" ? r : null;
        },
        { what: "the tab label to go back", timeoutMs: 15_000 },
      );
      const back = await renameRow();
      check("the tab reads the derived name again", back.tab, "Assistant #3");
      check("the header agrees", back.head, "Assistant #3");
      check("the record is back to the derived name", (await assistantState()).assistants.find((a) => a.id === A3)?.name, "Assistant #3");

      await page.reload({ waitUntil: "load" });
      await page.waitForSelector("section.project, .project", { timeout: 30_000 });
      await page.waitForSelector("#assistant", { state: "visible", timeout: 20_000 });
      await page.waitForTimeout(800);
      await openFloat();
      await openSettings();
      const finalRead = await waitFor(
        async () => {
          const r = await renameRow();
          return r.value === "Assistant #3" ? r : null;
        },
        { what: "the renamed-back name to be the stored one after a reload", timeoutMs: 15_000 },
      );
      check("a second reload reads Assistant #3", finalRead.tab, "Assistant #3");
      check("…in the header", finalRead.head, "Assistant #3");
      check("…in the input", finalRead.value, "Assistant #3");

      const queueEnd = await queueOf(A3);
      check("the queue rows survived the whole round trip", queueEnd.tasks.map((t) => t.title), ["carry the docs pass", "watch the deploy"]);
      ok("the queue file's bytes are still the ones it started with", readFileSync(queueFile, "utf8") === queueBytesBefore);
      check("the charter path is still the same", (await assistantState()).assistants.find((a) => a.id === A3)?.charter?.path, charterPath);

      check("no page errors", pageErrors, []);
      check("no console errors", consoleErrors, []);
      summaries.push(`"${NAME}" was saved on assistant-3's record, repainted its tab and the float's header with no reload, and a reload read it back`);
      summaries.push("the id, thread, queue file (rows and bytes) and charter path were unchanged across the rename and back");
      summaries.push("an empty name drew a visible refusal and Cancel restored the stored name without writing");
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
console.log("\nOK — an assistant's name is renamed from its own Settings, on its record, with the tab and header repainting");
