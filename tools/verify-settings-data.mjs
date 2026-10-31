// Settings > Data in a real browser: the two folders, their sizes, the migration sentence, and the two-press Clean scratch.
//
//   PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-settings-data.mjs
//
// What no node:test can see is the page: that the rows paint what /api/state says, that the first press on Clean scratch
// arms a cancel / clean pair, that cancel disarms, that the second press empties the folder and the row says what it
// freed. It found one real bug on the way in: the page's "a click outside closes Settings" handler judged the pressed
// button by `panel.contains(e.target)`, but the Clean scratch buttons swap themselves out of the DOM while the click is
// still bubbling, so the target was detached by then, the click read as "outside", and the drawer shut under the
// reader's first press. This script fails on that build and passes on the fix.
//
// Sandbox only: a panel on a free port with its own config, data directory and scratch directory under the OS temp
// folder, and a legacy logs/ beside the config for the first boot to copy. The reader's panel (:7331), ~/.wag and the
// real scratch directory are never touched. It does NOT press "open folder": that would start a file manager on the host.
// Without a Playwright install it says BROWSER-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCRATCH_MARKER } from "../lib/paths.js";
import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-NOT-RUN  Settings > Data was not exercised in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-settings-data.mjs");
  process.exit(2);
}

let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed += 1;
};
const norm = (s) => String(s).replace(/\\/g, "/").toLowerCase();

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-settings-data-"));
const legacy = path.join(dir, "logs");
mkdirSync(path.join(legacy, "attachments"), { recursive: true });
writeFileSync(path.join(legacy, "jobs.json"), `${JSON.stringify({ version: 1, savedAt: "2026-01-01T00:00:00.000Z", jobs: [] })}\n`);
writeFileSync(path.join(legacy, "todos.json"), "{}\n");
writeFileSync(path.join(legacy, "attachments", "shot.png"), "PNG");
const dataDir = path.join(dir, "data");
const scratchDir = path.join(dir, "scratch-folder");
// An `undefined` drops the key from the JSON, so the data directory is what answers (as in test/paths-http.test.js).
const panel = await startPanel({ dir, keep: true, config: { dataDir, scratchDir, jobsFile: undefined, assistantFile: undefined, projectsCacheFile: undefined } });
const browser = await pw.chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console: ${m.text()}`);
  });
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await openSettingsGroup(page, "data");
  await page.waitForFunction(
    () => !/measuring/.test(document.getElementById("data-dir-size").textContent) && !/measuring/.test(document.getElementById("scratch-dir-size").textContent),
    null,
    { timeout: 20_000 },
  );
  const read = () =>
    page.evaluate(() => ({
      dataSize: document.getElementById("data-dir-size").textContent,
      dataPath: document.getElementById("data-dir-path").textContent,
      scratchSize: document.getElementById("scratch-dir-size").textContent,
      scratchPath: document.getElementById("scratch-dir-path").textContent,
      openData: document.getElementById("btn-open-data")?.textContent || null,
      openScratch: document.getElementById("btn-open-scratch")?.textContent || null,
      drawerOpen: !document.getElementById("settings").classList.contains("hidden"),
    }));
  const actions = () => page.evaluate(() => [...document.querySelectorAll("#scratch-actions button")].map((b) => ({ id: b.id, text: b.textContent.trim() })));
  // If a build closes the drawer under a press, reopen it so the rest of the flow still runs and the report shows
  // everything that is wrong, not only the first thing.
  const ensureOpen = async () => {
    await openSettingsGroup(page, "data");
  };

  const before = await read();
  const idle = await actions();
  console.log(`Data directory   : ${before.dataSize} | ${before.dataPath.slice(0, 200)}`);
  console.log(`Scratch directory: ${before.scratchSize} | ${before.scratchPath.slice(0, 200)}`);
  check(norm(before.dataPath).includes(norm(dataDir)), "the Data row names the configured data directory");
  check(/set in config\.json/i.test(before.dataPath), "the Data row says where that path came from", (before.dataPath.match(/— [^·]*/) || [""])[0].trim());
  check(/\d+ files?/.test(before.dataSize) && !/measuring/.test(before.dataSize), "the Data row shows a measured size", before.dataSize);
  check(/3 files copied here from/.test(before.dataPath) && /originals were left where they were/.test(before.dataPath), "the Data row says the legacy logs/ was copied here and left in place");
  check(norm(before.scratchPath).includes(norm(scratchDir)), "the Scratch row names the configured scratch directory");
  check(/^0 B/.test(before.scratchSize), "the Scratch row shows its size (a fresh folder is empty; the marker is not counted)", before.scratchSize);
  check(before.openData === "open folder" && before.openScratch === "open folder", "both rows have an open-folder button (not pressed)");
  check(idle.length === 1 && idle[0].id === "btn-clean-scratch" && idle[0].text === "clean scratch", "one Clean scratch button at rest", JSON.stringify(idle.map((b) => b.text)));

  // Something to clean: a nested file and a loose one. Press 1 arms; cancel disarms; press 1 again then go cleans.
  mkdirSync(path.join(scratchDir, "cmp-tag", "nested"), { recursive: true });
  writeFileSync(path.join(scratchDir, "cmp-tag", "nested", "probe.txt"), "x".repeat(4096));
  writeFileSync(path.join(scratchDir, "export.json"), "{}");
  await page.click("#btn-clean-scratch");
  const afterArm = await read();
  check(afterArm.drawerOpen, "pressing Clean scratch leaves the Settings drawer open (it used to close under the press)");
  await ensureOpen();
  const armed = await actions();
  check(armed.length === 2 && armed[0].id === "btn-clean-cancel" && armed[1].id === "btn-clean-go" && /^clean /.test(armed[1].text), "press 1 arms a cancel / clean pair, in that order", JSON.stringify(armed.map((b) => b.text)));
  check(existsSync(path.join(scratchDir, "export.json")), "press 1 deleted nothing");
  await page.click("#btn-clean-cancel");
  const afterCancel = await read();
  check(afterCancel.drawerOpen, "cancel leaves the Settings drawer open");
  await ensureOpen();
  const disarmed = await actions();
  check(disarmed.length === 1 && disarmed[0].id === "btn-clean-scratch", "cancel puts the single button back");
  check(existsSync(path.join(scratchDir, "export.json")) && existsSync(path.join(scratchDir, "cmp-tag", "nested", "probe.txt")), "cancel deleted nothing");
  await page.click("#btn-clean-scratch");
  await ensureOpen();
  await page.click("#btn-clean-go");
  await page.waitForSelector("#btn-clean-scratch", { state: "attached", timeout: 15_000 });
  await page.waitForTimeout(600);
  const after = await read();
  const left = readdirSync(scratchDir);
  console.log(`after the clean  : ${after.scratchPath.slice(0, 120)} | folder holds ${JSON.stringify(left)}`);
  check(!left.includes("export.json") && !left.includes("cmp-tag"), "the clean emptied the folder, nested files included");
  check(left.includes(SCRATCH_MARKER), `the panel's marker file survived (${SCRATCH_MARKER}), so the folder stays cleanable`);
  check(/freed .* removed/.test(after.scratchPath) && after.drawerOpen, "the row reports what the clean did, with the drawer still open", (after.scratchPath.match(/freed [^—]*/) || [""])[0].trim());
  check(pageErrors.length === 0, "no page errors or console errors in the whole flow", pageErrors.slice(0, 3).join(" | "));
  check(/state-migrated: copied \d+ file\(s\)/.test(panel.log()), "the boot log says the migration happened");
  check(existsSync(path.join(legacy, "jobs.json")) && existsSync(path.join(legacy, "attachments", "shot.png")), "the legacy logs/ originals are still there (copied, never moved)");
} finally {
  await browser.close().catch(() => {});
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nSETTINGS-DATA-VERIFY-OK");
process.exit(failed ? 1 : 0);
