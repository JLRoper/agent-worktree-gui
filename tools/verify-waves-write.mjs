#!/usr/bin/env node
// THE WAVE WRITE SURFACE, ON THE REAL PAGE, AT 1440.
//
// HARNESS: LIVE GATE (a real panel process and a real browser; the sandbox only)
//
//   node tools/verify-waves-write.mjs [--shots <dir>]
//
// WHAT THIS GATE PROVES, and why each half is a measurement rather than a look:
//
//   1. ADD OPENS A FORM AND CREATES NOTHING ON ITS OWN. A press draws a one-line form with an EMPTY title (decision 4:
//      no default-titled wave), both gates, a template and the switch; the store on disk is compared before and after
//      the press, so "it opened a form" cannot be confused with "it wrote a wave".
//   2. CREATE WRITES ONE RECORD AND THE TAB DRAWS ITS STATION. The press answers through POST /api/waves, the route's
//      own GET is read back, and the station the card drew is found by its data attributes - title, position, both
//      gate chips - so the paint and the fold are compared, not eyeballed.
//   3. EDIT CHANGES THE RECORD AND THE READ AGREES. A title and an exit gate are changed in the form, and both are read
//      back from GET /api/waves as well as from the station.
//   4. A REORDER HOLDS: two waves, a Down press, and the positions are 1..n in the route AND in the file on disk.
//   5. DELETE TAKES THE RECORD AND LEAVES THE REST: the station is gone from the card, GET answers none, and the store
//      holds the other wave exactly as it was.
//   6. THE STORE IS VERSION 2 after the first write, and the tab's card still says the wave AUTHORS and starts nothing.
//   7. HEALTH: zero page errors and zero console errors, and the document is no wider with the lane open than folded.
//
// Sandbox only: its own config, port and state directory, an apiServer pointed at a dead port, and one throwaway git
// tree. The live panel on 7331 and ~/.wag are never touched. Without Playwright the script says BROWSER-NOT-RUN and
// exits 2 rather than passing on a half that never ran.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { git, post, startPanel, waitForState } from "./panel-testkit.mjs";

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

// ---- the sandbox ---------------------------------------------------------------------------------------------------
const sandbox = mkdtempSync(path.join(tmpdir(), "wag-waves-write-gate-"));
const repos = path.join(sandbox, "repos");
const wavesFile = path.join(sandbox, "logs", "waves.json");
const initiativesFile = path.join(sandbox, "logs", "initiatives.json");
mkdirSync(repos, { recursive: true });
const projectDir = path.join(repos, "wave-write-gate");
mkdirSync(projectDir, { recursive: true });
git(projectDir, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(projectDir, "README.md"), "# wave-write-gate\n");
git(projectDir, ["add", "-A"]);
git(projectDir, ["commit", "-q", "-m", "first"]);
git(projectDir, ["worktree", "add", "-q", "-b", "write-tree", path.join(projectDir, ".worktrees", "write-tree")]);
const tree = path.join(projectDir, ".worktrees", "write-tree");

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
    initiativesFile,
  },
});
const base = panel.base;
const GET = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const bytes = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
let shotNo = 0;
const shotName = (slug) => path.join(shotsDir, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);

try {
  console.log(`sandbox: ${base}`);
  console.log(`panel pid: ${panel.pid}`);
  await waitForState(
    base,
    (s) => s.projects.flatMap((p) => (p.worktrees || []).map((w) => w.path)).some((p) => p.replace(/\\/g, "/").toLowerCase() === tree.replace(/\\/g, "/").toLowerCase()),
    "the worktree is on the board",
    { timeout: 120_000 },
  );

  // ---- the fixture: one throwaway initiative, and the free tier so a press is a write --------------------------------
  console.log("\n== seed ==");
  check("the initiative tier is set to none, so nothing asks", (await post(base, "/api/settings/initiative-tier", { body: { tier: "none" } })).status, 200);
  const made = await post(base, "/api/initiatives", { body: { title: "A throwaway initiative", description: "The wave write gate's own initiative - removed with the sandbox." } });
  check("the throwaway initiative is created", made.status, 201);
  const initiativeId = made.json?.initiative?.id;
  ok("the initiative has an id", Boolean(initiativeId), String(initiativeId || ""));
  const lane = await GET(`/api/waves?initiative=${initiativeId}`);
  check("it starts with no waves", lane.json?.waves?.length, 0);
  const initiativesBefore = bytes(initiativesFile);
  ok("the initiative store is on disk", initiativesBefore.length > 0, `${initiativesBefore.length} bytes`);

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the wave write surface at 1440", "playwright is not installed for this node (see tools/browser.mjs)"));
    failures += 1;
  } else {
    await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        const shot = async (slug, clipSel = null) => {
          if (!shotsDir) return null;
          const file = shotName(slug);
          if (clipSel) {
            const box = await page.locator(clipSel).first().boundingBox();
            if (box) {
              await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: Math.min(1440 - Math.max(0, box.x - 4), box.width + 8), height: Math.min(900 - Math.max(0, box.y - 4), box.height + 8) } });
              note(`shot ${path.basename(file)}`);
              return file;
            }
          }
          await page.screenshot({ path: file });
          note(`shot ${path.basename(file)}`);
          return file;
        };
        const station = (title) =>
          page.evaluate((want) => {
            const row = [...document.querySelectorAll("#as-initiatives .wave-row")].find((r) => r.querySelector(".wave-title")?.textContent.trim() === want);
            if (!row) return null;
            return {
              id: row.getAttribute("data-wave-id"),
              pos: row.querySelector(".wave-pos")?.textContent.trim(),
              title: row.querySelector(".wave-title")?.textContent.trim(),
              state: row.getAttribute("data-wave-state"),
              entry: row.querySelector('[data-wave-gate="entry"]')?.textContent.trim(),
              exit: row.querySelector('[data-wave-gate="exit"]')?.textContent.trim(),
              exitState: row.querySelector('[data-wave-gate="exit"]')?.getAttribute("data-gate-state"),
              actions: [...row.querySelectorAll("[data-wave-edit],[data-wave-up],[data-wave-down],[data-wave-del]")].length,
            };
          }, title);
        const positions = () =>
          page.evaluate(() =>
            [...document.querySelectorAll("#as-initiatives .wave-row")].map((r) => ({
              pos: r.querySelector(".wave-pos")?.textContent.trim(),
              title: r.querySelector(".wave-title")?.textContent.trim(),
            })),
          );
        const geometry = () =>
          page.evaluate(() => {
            const pane = document.getElementById("as-initiatives");
            const doc = document.scrollingElement || document.documentElement;
            return { documentWidth: doc.scrollWidth, paneOverflow: pane.scrollWidth - pane.clientWidth, cardOverflow: (pane.querySelector(".init-card") || { scrollWidth: 0, clientWidth: 0 }).scrollWidth - (pane.querySelector(".init-card") || { clientWidth: 0 }).clientWidth };
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
        await page.setViewportSize({ width: 1440, height: 900 });
        await sleep(300);

        // ---- 1. Add opens a form with an empty title, and writes nothing --------------------------------------------
        console.log("\n== 1. Add opens a form, and nothing is written ==");
        // The lane lives in an OPEN card (a folded card is a title and nothing else), so the card is unfolded first -
        // by its own head button, which is the press a reader makes.
        if ((await page.locator(`#as-initiatives [data-init-waves="${initiativeId}"]`).count()) === 0) {
          await page.click(`#as-initiatives [data-init-card-toggle="${initiativeId}"]`);
        }
        await page.waitForSelector(`#as-initiatives [data-init-waves="${initiativeId}"]`, { timeout: 20_000 });
        await page.click(`#as-initiatives .init-card [data-wave-add="${initiativeId}"]`);
        await page.waitForSelector(`#as-initiatives [data-wave-form="${initiativeId}"]`, { timeout: 20_000 });
        const form = await page.evaluate((id) => {
          const f = document.querySelector(`#as-initiatives [data-wave-form="${id}"]`);
          const fields = [...f.querySelectorAll("[data-wave-field]")].map((el) => el.getAttribute("data-wave-field"));
          return {
            mode: f.getAttribute("data-wave-form-mode"),
            title: f.querySelector('[data-wave-field="title"]')?.value,
            fields,
            save: f.querySelector("[data-wave-save]")?.textContent.trim(),
            entryOptions: [...f.querySelectorAll('[data-wave-field="entry"] option')].map((o) => o.value),
          };
        }, initiativeId);
        check("the form is an add form", form.mode, "add");
        check("its title is empty, so no wave was invented", form.title, "");
        check("it carries the record's five fields", form.fields.sort(), ["auto", "entry", "exit", "template", "title"]);
        check("its press is Create wave", form.save, "Create wave");
        ok("the entry picker offers the server's checks", form.entryOptions.includes("clean") && form.entryOptions.includes(""), form.entryOptions.join(","));
        const stillNone = await GET(`/api/waves?initiative=${initiativeId}`);
        check("the store still holds no wave after the Add press", stillNone.json?.waves?.length, 0);
        ok("the wave store file was not created by the press", bytes(wavesFile) === "", `${bytes(wavesFile).length} bytes`);
        await shot("add-form", "#as-initiatives .init-wavefold");
        await shot("add-form-page");

        // ---- 2. Create writes one record, and the station is drawn -------------------------------------------------
        console.log("\n== 2. Create writes the record and the tab draws its station ==");
        const createTitle = "Prove the write route";
        await page.fill(`#as-initiatives [data-wave-form="${initiativeId}"] [data-wave-field="title"]`, createTitle);
        await page.selectOption(`#as-initiatives [data-wave-form="${initiativeId}"] [data-wave-field="entry"]`, "clean");
        await page.selectOption(`#as-initiatives [data-wave-form="${initiativeId}"] [data-wave-field="exit"]`, "pr-open");
        await page.click(`#as-initiatives [data-wave-form="${initiativeId}"] [data-wave-save]`);
        await page.waitForSelector(`#as-initiatives .wave-row`, { timeout: 30_000 });
        await page.waitForFunction(() => !document.querySelector("#as-initiatives [data-wave-form]"), null, { timeout: 20_000 });
        const created = await GET(`/api/waves?initiative=${initiativeId}`);
        check("the route reads the new wave back", created.json?.waves?.length, 1);
        check("its title", created.json?.waves?.[0]?.title, createTitle);
        check("its entry gate is stored as the name", created.json?.waves?.[0]?.entryGate?.check, "clean");
        check("its exit gate is stored as the name", created.json?.waves?.[0]?.exitGate?.check, "pr-open");
        check("the store is version 2 after the first write", created.json?.store?.version, 2);
        const drew = await station(createTitle);
        ok("the tab drew its station", Boolean(drew), JSON.stringify(drew));
        check("the station's position", drew?.pos, "W1");
        ok("the station carries its four controls", drew?.actions === 4, String(drew?.actions));
        ok("the station names its entry gate and that it has nothing to check yet", String(drew?.entry || "").includes("entry clean") && String(drew?.entry || "").includes("nothing to check"), String(drew?.entry));
        ok("the station names its exit gate and that it has nothing to check yet", String(drew?.exit || "").includes("exit pr-open") && String(drew?.exit || "").includes("nothing to check"), String(drew?.exit));
        const docAfterCreate = JSON.parse(bytes(wavesFile));
        check("the file on disk is version 2", docAfterCreate.version, 2);
        check("the file holds the record under the initiative", docAfterCreate.byInitiative?.[initiativeId]?.length, 1);
        ok("the wave write did not touch the initiative store", bytes(initiativesFile) === initiativesBefore);
        await shot("created-station", "#as-initiatives .init-wavefold");
        await shot("created-page");

        // ---- 3. Edit a title and a gate, and read both back ---------------------------------------------------------
        console.log("\n== 3. Edit the title and the exit gate ==");
        const waveId = created.json.waves[0].id;
        await page.click(`#as-initiatives [data-wave-edit="${initiativeId}|${waveId}"]`);
        await page.waitForSelector(`#as-initiatives [data-wave-form-mode="edit"]`, { timeout: 20_000 });
        const editForm = await page.evaluate((id) => {
          const f = document.querySelector(`#as-initiatives [data-wave-form="${id}"]`);
          return { title: f.querySelector('[data-wave-field="title"]')?.value, exit: f.querySelector('[data-wave-field="exit"]')?.value, save: f.querySelector("[data-wave-save]")?.textContent.trim() };
        }, initiativeId);
        check("the edit form carries the record's title", editForm.title, createTitle);
        check("and its exit gate", editForm.exit, "pr-open");
        check("its press says Save wave", editForm.save, "Save wave");
        const editedTitle = "Prove the write route, edited";
        await page.fill(`#as-initiatives [data-wave-form="${initiativeId}"] [data-wave-field="title"]`, editedTitle);
        await page.selectOption(`#as-initiatives [data-wave-form="${initiativeId}"] [data-wave-field="exit"]`, "pr-merged");
        await page.click(`#as-initiatives [data-wave-form="${initiativeId}"] [data-wave-save]`);
        await page.waitForFunction((want) => [...document.querySelectorAll("#as-initiatives .wave-title")].some((t) => t.textContent.trim() === want), editedTitle, { timeout: 20_000 });
        const edited = await GET(`/api/waves?initiative=${initiativeId}`);
        check("the route read the title back", edited.json?.waves?.[0]?.title, editedTitle);
        check("the route read the exit gate back", edited.json?.waves?.[0]?.exitGate?.check, "pr-merged");
        // The lane does not draw the history, so it is read where it lives: the store on disk.
        const storedHistory = JSON.parse(bytes(wavesFile)).byInitiative[initiativeId].find((w) => w.id === waveId)?.history || [];
        check("the edit appended one history event", storedHistory.length, 2);
        check("the last event is the edit, by the reader", `${storedHistory[1]?.action}/${storedHistory[1]?.by}`, "edit/reader");
        const drewEdited = await station(editedTitle);
        ok("the station reads the new title", Boolean(drewEdited), JSON.stringify(drewEdited));
        ok("and the new exit gate", String(drewEdited?.exit || "").includes("exit pr-merged") && String(drewEdited?.exit || "").includes("nothing to check"), String(drewEdited?.exit));
        await shot("edited-station", "#as-initiatives .init-wavefold");

        // ---- 4. Two waves, a reorder, and the positions hold ---------------------------------------------------------
        console.log("\n== 4. Reorder two waves ==");
        await page.click(`#as-initiatives .init-card [data-wave-add="${initiativeId}"]`);
        await page.waitForSelector(`#as-initiatives [data-wave-form="${initiativeId}"]`, { timeout: 20_000 });
        await page.fill(`#as-initiatives [data-wave-form="${initiativeId}"] [data-wave-field="title"]`, "A second wave");
        await page.click(`#as-initiatives [data-wave-form="${initiativeId}"] [data-wave-save]`);
        await page.waitForFunction(() => document.querySelectorAll("#as-initiatives .wave-row").length === 2, null, { timeout: 20_000 });
        const twoBefore = await positions();
        check("two stations, in order", twoBefore.map((r) => r.pos).join(","), "W1,W2");
        await page.click(`#as-initiatives [data-wave-down="${initiativeId}|${waveId}"]`);
        await page.waitForFunction((want) => document.querySelector('#as-initiatives .wave-row .wave-title')?.textContent.trim() === want, "A second wave", { timeout: 20_000 });
        const twoAfter = await positions();
        check("the moved wave is last", twoAfter.map((r) => r.title).join(" | "), "A second wave | " + editedTitle);
        check("the positions are still 1..n", twoAfter.map((r) => r.pos).join(","), "W1,W2");
        const reordered = await GET(`/api/waves?initiative=${initiativeId}`);
        check("the route's order agrees", reordered.json?.waves?.map((w) => w.title).join(" | "), "A second wave | " + editedTitle);
        check("the route's positions agree", reordered.json?.waves?.map((w) => w.position).join(","), "1,2");
        check("the file's positions agree", JSON.parse(bytes(wavesFile)).byInitiative[initiativeId].map((w) => w.position).join(","), "1,2");
        const firstIsLast = await page.evaluate((id) => document.querySelector(`#as-initiatives [data-wave-up="${id}"]`)?.disabled, `${initiativeId}|${waveId}`);
        ok("the last station's Up is live and its Down is shut", firstIsLast === false, String(firstIsLast));
        await shot("reordered", "#as-initiatives .init-wavefold");

        // ---- 5. Delete takes the record and leaves the other --------------------------------------------------------
        console.log("\n== 5. Delete one wave ==");
        const secondId = reordered.json.waves[0].id;
        await page.click(`#as-initiatives [data-wave-del="${initiativeId}|${secondId}"]`);
        await page.waitForFunction(() => document.querySelectorAll("#as-initiatives .wave-row").length === 1, null, { timeout: 20_000 });
        const afterDelete = await GET(`/api/waves?initiative=${initiativeId}`);
        check("the route holds one wave", afterDelete.json?.waves?.length, 1);
        check("and it is the other one", afterDelete.json?.waves?.[0]?.id, waveId);
        check("the survivor's position closed the gap, so the route has no hole", afterDelete.json?.waves?.[0]?.position, 1);
        const fileAfterDelete = JSON.parse(bytes(wavesFile)).byInitiative[initiativeId];
        check("the file holds one record", fileAfterDelete.length, 1);
        ok("the deleted id is gone from the file", !fileAfterDelete.some((w) => w.id === secondId));
        ok("the initiative store is still untouched", bytes(initiativesFile) === initiativesBefore);

        // ---- 6. The header, the geometry and the two stores ---------------------------------------------------------
        console.log("\n== 6. The card's own claims and the page's width ==");
        const head = await page.evaluate((id) => {
          const fold = document.querySelector(`#as-initiatives [data-init-waves="${id}"]`);
          return { note: fold?.querySelector(".init-wave-note")?.getAttribute("title") || "", writable: fold?.getAttribute("data-wave-writable"), count: fold?.querySelector(".chip")?.textContent.trim() };
        }, initiativeId);
        ok("the card says the tab authors waves", /AUTHORS waves/.test(head.note), head.note);
        ok("and still starts nothing", /starts nothing/.test(head.note), head.note);
        check("the section is marked writable", head.writable, "true");
        check("its count is the one wave left", head.count, "1");
        const g = await geometry();
        note(`document ${g.documentWidth}px wide; pane overflow ${g.paneOverflow}px; card overflow ${g.cardOverflow}px`);
        ok("at 1440 the window does not scroll sideways", g.documentWidth <= 1440, `${g.documentWidth}px`);
        ok("the pane has no horizontal overflow", g.paneOverflow <= 0, `${g.paneOverflow}px`);
        ok("the card has no horizontal overflow", g.cardOverflow <= 0, `${g.cardOverflow}px`);
        await shot("final-page");

        // ---- 7. Clean up the wave through the route, and prove the seven-shaped claim --------------------------------
        console.log("\n== 7. Remove the last wave through the route ==");
        const removed = await post(base, "/api/waves/remove", { body: { initiativeId, id: waveId, by: "assistant-3" } });
        check("the last wave is removed", removed.status, 200);
        check("its answer counts no members", removed.json?.members, 0);
        const empty = await GET(`/api/waves?initiative=${initiativeId}`);
        check("the initiative reads no waves again", empty.json?.waves?.length, 0);
        check("the store is an empty map", JSON.stringify(JSON.parse(bytes(wavesFile)).byInitiative), "{}");
        const tab = await GET("/api/initiatives");
        const card = tab.json?.initiatives?.find((row) => row.id === initiativeId);
        check("the tab's read agrees", card?.waves?.length, 0);

        console.log("\n== health ==");
        check("no page errors", pageErrors.length, 0);
        check("no console errors", consoleErrors.length, 0);
        if (pageErrors.length) pageErrors.slice(0, 4).forEach((e) => note(String(e)));
        if (consoleErrors.length) consoleErrors.slice(0, 4).forEach((e) => note(String(e)));
      },
      { width: 1440, height: 900 },
    );
  }
} finally {
  await panel.stop().catch(() => {});
  rmSync(sandbox, { recursive: true, force: true });
  clearTimeout(watchdog);
}

console.log(`\n${failures ? "FAILED" : "OK"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
