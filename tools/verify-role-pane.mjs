// THE ROLE PANE CARRIES TEXT, NOT A PICKER: the charter box and its Save, and no way to change what an assistant runs.
//
//   node tools/verify-role-pane.mjs
//
// The ability to change an assistant's role was taken off the shared Role tab: the "editing <assistant>" selector, the
// role picker and "Adopt this role's charter" are gone, and that assistant's own Settings (The role it runs) is the one
// place a role is changed. What the tab KEEPS is driven here, on a sandbox panel of its own and a real Chromium over it:
//
//   1. THE PANE DRAWS NO PICKER: #as-roletarget, #as-role-pick and #btn-as-role-adopt do not exist; the pane says whose
//      copy it edits, names the role the record runs with its description, and points at Settings for the choice;
//   2. THE BOX HOLDS THIS ASSISTANT'S COPY, byte for byte, and Save writes what is in it to that copy on disk;
//   3. A 19,773-character charter saves clean; an edit past the 20,000 cap warns BEFORE the press, disables Save, and a
//      forced press refuses without a request; pruning under the cap clears the warning;
//   4. SETTINGS IS THE ONE PLACE A ROLE CHANGES: picking one there writes the record, does NOT adopt the role's charter
//      (the box keeps this assistant's copy), and the Role pane's role line follows the record;
//   5. CREATE ROLE still makes a role from the one the pane is on, and NEW ASSISTANT FROM THIS ROLE still starts a
//      second assistant on it;
//   6. no page errors, and zero browser dialogs throughout.
//
// HARNESS: LIVE GATE
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlaywright } from "./browser.mjs";
import { startPanel, waitFor } from "./panel-testkit.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 180_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing - see the last line printed above.\n`);
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
const note = (text) => console.log(`      ${text}`);

const CAP = 20_000;
const pad = (prefix, length) => `${prefix}${"x".repeat(Math.max(0, length - prefix.length))}`;

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-role-pane-"));
let panel = null;
let browser = null;
try {
  panel = await startPanel({
    dir,
    config: {
      refreshSeconds: 4,
      worktreeSeconds: 2,
      midSeconds: 8,
      threads: 1,
      // A DEAD port on purpose: nothing here may reach the live gateway, and nothing here spawns a run.
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    },
  });
  const base = panel.base;
  note(`sandbox panel ${base} (its own PANEL_CONFIG and HERMES_HOME; live 7331 untouched)`);

  const post = async (route, body) => {
    const r = await fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${route}: HTTP ${r.status} ${d.error || ""}`);
    return d;
  };
  const roleOf = async (assistantId = "assistant-1") => await (await fetch(`${base}/api/assistant/role?assistantId=${encodeURIComponent(assistantId)}`)).json();
  const charterOf = async (roleId) => (await (await fetch(`${base}/api/assistant/role/charter?roleId=${encodeURIComponent(roleId)}`)).json()).text;

  // The role library the pane sits in: one short reviewer and one role whose own text sits at the brief's 19,773.
  const reviewer = "# Reviewer charter\n\nREAD-THE-DIFF\n";
  const edge = pad("# Edge role\n\n", 19_773);
  check("the edge charter sits at the brief's 19,773", edge.length, 19_773);
  await post("/api/assistant/roles", { name: "Reviewer", description: "reads a diff and says no", charter: reviewer });
  await post("/api/assistant/roles", { name: "Edge Role", description: "sits just under the cap", charter: edge });
  const seededBaseline = (await roleOf()).charter.text;
  ok("the assistant starts on the seeded role with its own copy", seededBaseline.length > 1_000 && seededBaseline.length !== 19_773, `${seededBaseline.length} chars, its own file`);

  // ---- the browser half --------------------------------------------------------------------------
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    failures += 1;
  } else {
    const pageErrors = [];
    const dialogs = [];
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });
    // A browser dialog is the one thing this tab must never use: record every one and dismiss it, so the checks
    // below can prove the count is zero rather than infer it from a passing flow.
    page.on("dialog", async (d) => {
      dialogs.push(`${d.type()}: ${d.message()}`);
      await d.dismiss().catch(() => {});
    });

    const shot = async (name) => {
      const into = process.env.PANEL_VERIFY_ARTIFACTS;
      if (!into) return null;
      try {
        mkdirSync(into, { recursive: true });
        const file = path.join(into, name);
        await page.screenshot({ path: file, fullPage: false });
        return file;
      } catch {
        return null;
      }
    };
    const box = () => page.locator("#as-role-text").inputValue();
    const textOf = async (sel) => ((await page.locator(sel).count()) ? page.locator(sel).innerText() : "");
    const hold = () => textOf("#as-role [data-as-roleholds]");
    const sizeLine = () => textOf("#as-role [data-as-rolesize]");
    const saveLine = () => textOf("#as-role [data-as-rolesave]");
    const remit = async () => ((await page.locator("#as-role .as-help").count()) ? page.locator("#as-role .as-help").first().innerText() : "");
    const paneText = () => textOf("#as-role");
    const saveDisabled = () => page.locator("#btn-as-role").isDisabled();
    const openRole = async () => {
      await page.click('#as-tabs [data-as-tab="role"]');
      await page.waitForSelector("#as-role:not(.hidden)");
      await page.waitForFunction(() => !document.querySelector("#as-role-text").readOnly, null, { timeout: 15_000 });
    };

    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-assistant", { timeout: 20_000 });
    await page.click("#btn-assistant");
    await page.waitForSelector("#assistant", { state: "visible" });
    await openRole();

    console.log("\n== the pane draws no way to change what an assistant runs ==");
    check("#as-roletarget is gone", await page.locator("#as-roletarget").count(), 0);
    check("#as-role-pick is gone", await page.locator("#as-role-pick").count(), 0);
    check("#btn-as-role-adopt is gone", await page.locator("#btn-as-role-adopt").count(), 0);
    ok("the pane says whose copy it edits", /Assistant #1's own copy/.test(await textOf("[data-as-rolewho]")), await textOf("[data-as-rolewho]"));
    ok("...and points at Settings as the one place a role is changed", /changed in that assistant's own\s+Settings/i.test(await paneText()));
    ok("the role the record runs is named with its remit", /Agent Manager/.test(await remit()) && /approved PR ready to merge/i.test(await remit()), (await remit()).slice(0, 120));
    ok("the box holds the assistant's copy, byte for byte", (await box()) === seededBaseline, `${seededBaseline.length} chars`);
    ok("...and the provenance says so", /^this assistant's own copy/.test(await hold()), await hold());
    ok("...with its size against the cap", /^\d+\/20000 chars/.test(await sizeLine()), await sizeLine());
    ok("the buttons that stay are Save, Reload, Create role and New assistant", (await page.$$eval("#as-role button", (els) => els.map((e) => e.id))).join(), "btn-as-role,btn-as-role-reload,btn-as-new-assistant,btn-as-role-newrole");

    console.log("\n== Save writes what the box holds to this assistant's copy ==");
    const edited = "# Edited in the pane\n\nSAVED-FROM-THE-PANE\n";
    await page.fill("#as-role-text", edited);
    await page.click("#btn-as-role");
    ok(
      "the save lands on this assistant's copy",
      await waitFor(async () => (await roleOf()).charter.text === edited, { timeoutMs: 15_000, what: "the copy to land" }),
    );
    ok("...and the provenance flips to the copy read from disk", await waitFor(async () => /^this assistant's own copy/.test(await hold()), { timeoutMs: 10_000, what: "the provenance" }), await hold());
    ok("...under the cap, so no warning is up", (await page.locator("#as-role-cap").count()) === 0);

    console.log("\n== a 19,773-character charter saves clean, and the cap warns before the press ==");
    await page.fill("#as-role-text", edge);
    ok("the 19,773-character charter leaves Save live", !(await saveDisabled()));
    ok("...with no cap warning", (await page.locator("#as-role-cap").count()) === 0);
    await page.click("#btn-as-role");
    ok(
      "and it saves whole",
      await waitFor(async () => (await roleOf()).charter.text === edge, { timeoutMs: 15_000, what: "the big save to land" }),
      `${edge.length} chars`,
    );
    // The save's own repaint replaces the box with the copy it wrote, and it lands after the server has the text: wait
    // for that render before typing over it, or the next fill is wiped by it.
    ok("...and the pane repaints from the copy it wrote", await waitFor(async () => /read from disk/.test(await saveLine()), { timeoutMs: 10_000, what: "the save repaint" }), await saveLine());
    await page.fill("#as-role-text", `${edge}${"y".repeat(300)}`);
    ok("crossing the cap grows the warning row", await waitFor(async () => (await page.locator("#as-role-cap").count()) === 1, { timeoutMs: 5_000, what: "the cap warning" }));
    const warn = await waitFor(async () => (await textOf("#as-role-cap")) || null, { timeoutMs: 5_000, what: "the cap warning's words" });
    ok("...with the numbers", /20,073 characters/.test(warn) && /73 over the 20,000-character cap/.test(warn), warn.replace(/\s+/g, " "));
    ok("...and Save is disabled before it can be pressed", await saveDisabled());
    check("...and the size line is marked bad", /is-bad/.test(await page.locator("#as-role [data-as-rolesize]").getAttribute("class")), true);
    // The keyboard path: force the disabled button and press it. The handler must refuse without a request, so the
    // copy on disk stays exactly what it was.
    await page.evaluate(() => {
      const b = document.querySelector("#btn-as-role");
      b.disabled = false;
      b.click();
    });
    ok(
      "a forced press refuses with the cap's own words",
      await waitFor(async () => /the charter is 20073 characters and the cap is 20000/.test(await page.locator("#as-role-err").innerText()), { timeoutMs: 5_000, what: "the refusal" }),
      await page.locator("#as-role-err").innerText(),
    );
    check("...and wrote nothing", (await roleOf()).charter.text.length, edge.length);
    await shot("role-pane-cap.png");
    await page.fill("#as-role-text", edge);
    ok("pruning under the cap clears the warning", await waitFor(async () => (await page.locator("#as-role-cap").count()) === 0, { timeoutMs: 5_000, what: "the warning to clear" }));
    ok("...and Save comes back alive", !(await saveDisabled()));

    console.log("\n== Settings is the one place a role changes, and it does not adopt the charter ==");
    await page.click('#as-tabs [data-as-tab="assistant-1"]');
    await page.waitForSelector("#as-subtabs");
    await page.click('#as-subtabs [data-as-subtab="settings"]');
    await page.waitForSelector("#as-settings:not(.hidden)");
    check(
      "the Settings role row is the control the pane no longer carries",
      await page.locator('#as-settings [data-as-setrole="assistant-1"]').count(),
      1,
    );
    await page.selectOption('#as-settings [data-as-setrole="assistant-1"]', "reviewer");
    ok(
      "the pick writes the role on this assistant's record",
      await waitFor(async () => (await roleOf()).role.id === "reviewer", { timeoutMs: 15_000, what: "the record's role to move" }),
    );
    ok("...and the row says so", /runs the Reviewer role/.test(await page.locator('[data-as-rolestatus="assistant-1"]').innerText()), await page.locator('[data-as-rolestatus="assistant-1"]').innerText());
    await openRole();
    ok("the Role pane's role line follows the record", await waitFor(async () => /Reviewer/.test(await remit()), { timeoutMs: 15_000, what: "the pane to read the new role" }), (await remit()).slice(0, 120));
    ok("...while the box still holds this assistant's copy, not the role's charter", (await box()) === edge, `${edge.length} chars`);
    check("...and the copy on disk was not touched", (await roleOf()).charter.text.length, edge.length);
    check("...so the pick adopted nothing", (await roleOf()).sameAsRole, false);

    console.log("\n== Create role still copies the role the pane is on ==");
    await page.fill("#as-role-name", "Third Role");
    await page.click("#btn-as-role-newrole");
    const lib = await waitFor(
      async () => {
        const d = await roleOf();
        return (d.roles || []).some((r) => r.name === "Third Role") ? d : null;
      },
      { timeoutMs: 15_000, what: "the new role to appear in the library" },
    );
    ok("the library carries the new role", Boolean(lib), (lib.roles || []).map((r) => r.name).join(", "));
    const third = (lib.roles || []).find((r) => r.name === "Third Role");
    check("...made from the role this assistant runs", await charterOf(third.id), reviewer);
    ok(
      "...and the name box is cleared for the next one",
      await waitFor(async () => (await page.locator("#as-role-name").inputValue()) === "", { timeoutMs: 10_000, what: "the name box to clear" }),
    );

    console.log("\n== New assistant from this role still starts a second assistant on it ==");
    await page.click("#btn-as-new-assistant");
    ok(
      "the top row gains Assistant #2",
      await waitFor(async () => (await page.locator('#as-tabs [data-as-tab="assistant-2"]').count()) === 1, { timeoutMs: 15_000, what: "Assistant #2's tab" }),
    );
    ok(
      "it runs the role the pane was on",
      await waitFor(async () => (await roleOf("assistant-2")).role.id === "reviewer", { timeoutMs: 15_000, what: "#2's role" }),
    );
    const two = await roleOf("assistant-2");
    ok("...with its own copy of the role's charter", two.charter.text === reviewer && two.sameAsRole === true, `${two.charter.text.length} chars`);

    console.log("\n== the page's own health ==");
    check("no browser dialogs in the whole run", dialogs, []);
    check("no page errors", pageErrors, []);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a real panel process on its own port over its own PANEL_CONFIG and HERMES_HOME, two roles");
  console.log("created through its own route, and headless Chromium over it. The Role pane was proved to carry no");
  console.log("selector, no role picker and no adopt press; its box and Save, the 19,773-character save, the cap warning");
  console.log("and its refusal, the Settings pick that moves the record without adopting the charter, Create role and");
  console.log("New assistant from this role were all exercised. Browser dialogs: zero by counter, not by inspection.");
  if (!failures) console.log("ROLE-PANE-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panel) console.log(`--- panel log (tail)\n${panel.log().split(/\r?\n/).slice(-25).join("\n")}`);
} finally {
  watchdog.unref?.();
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* already gone */
    }
  }
  if (panel) await panel.stop();
  if (process.env.VERIFY_KEEP === "1") console.log(`VERIFY_KEEP=1 - leaving ${dir} in place`);
  else rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (failures) process.exitCode = 1;
}
