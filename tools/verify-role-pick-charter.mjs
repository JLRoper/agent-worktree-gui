// The Role tab's picker loads THAT role's own charter into the box — and the box says what it holds.
//
//   node tools/verify-role-pick-charter.mjs
//
// Before this change `#as-role-pick` moved only the description line: `#as-role-text` kept the previous role's
// charter until Adopt was pressed or the page reloaded, so the two visibly disagreed. What is driven here, on a
// sandbox panel of its own and a real Chromium over it:
//
//   1. a CLEAN pick loads the role's own text: the box equals that role's charter byte for byte, the description
//      line names that role, the provenance line says "the role's own text", and the assistant's copy on disk has
//      NOT moved (the pick is adopt:false). Save then writes the copy, and the provenance flips to the copy;
//   2. a DIRTY box refuses to lose the typed text: changing the picker opens an INLINE row — no browser dialog —
//      with Keep mine / Use the role's, the box still holds the words, no pick reached the server, and the
//      description line still describes the text on screen. "Keep mine" puts the picker back; "Use the role's"
//      loads the pick;
//   3. the CAP is checked against the text that would be sent: a 19,773-character role loads without a warning,
//      an edit past 20,000 warns and disables Save BEFORE the press (and the press itself refuses without a
//      request), and a role whose own text is already over the cap warns the moment it lands;
//   4. Adopt still works for anyone used to it: it asks inline when the copy differs, then replaces the copy, and
//      sameAsRole reads true afterwards;
//   5. no page errors, and zero browser dialogs throughout.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAP = 20_000;
const pad = (prefix, length) => `${prefix}${"x".repeat(Math.max(0, length - prefix.length))}`;

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-role-pick-"));
let panel = null;
let browser = null;
try {
  const port = await (async () => {
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
    return panel.port;
  })();
  const base = panel.base;
  note(`sandbox panel ${base} (its own PANEL_CONFIG and HERMES_HOME; live 7331 untouched)`);

  const post = async (route, body) => {
    const r = await fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${route}: HTTP ${r.status} ${d.error || ""}`);
    return d;
  };
  const roleOf = async (assistantId = "assistant-1") => (await (await fetch(`${base}/api/assistant/role?assistantId=${encodeURIComponent(assistantId)}`)).json());

  // The role library the tab will offer: one short reviewer, one second job, one exactly at the brief's 19,773, and
  // one whose own text is already over the cap. Created over the panel's own route BEFORE the page reads them, so
  // the picker carries all four without a reload.
  const reviewer = "# Reviewer charter\n\nREAD-THE-DIFF\n";
  const second = "# Second role\n\nSECOND-ROLE-TEXT\n";
  const edge = pad("# Edge role\n\n", 19_773);
  const overlong = pad("# Overlong\n\n", CAP + 1);
  check("the edge charter sits at the brief's 19,773", edge.length, 19_773);
  check("the overlong charter is one past the cap", overlong.length, CAP + 1);
  for (const [name, description, charter] of [
    ["Reviewer", "reads a diff and says no", reviewer],
    ["Second Role", "a different job entirely", second],
    ["Edge Role", "sits just under the cap", edge],
    ["Overlong Role", "already past the line", overlong],
  ]) {
    await post("/api/assistant/roles", { name, description, charter });
  }
  const seededBaseline = (await roleOf()).charter.text;
  ok("the assistant starts on the seeded role with its own copy", seededBaseline.length > 1_000 && seededBaseline.length !== 19_773, `${seededBaseline.length} chars, its own file`);
  // A second assistant, so the target selector has two files to tell apart and a switch can be asked about.
  await post("/api/assistant/assistants", { roleId: "agent-manager" });

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
    const askText = () => textOf("#as-role-ask");
    const picker = () => page.locator("#as-role-pick").inputValue();
    const saveDisabled = () => page.locator("#btn-as-role").isDisabled();
    const waitBox = (text) => waitFor(async () => (await box()) === text, { timeoutMs: 15_000, what: "the box to hold the expected text" });
    const waitAsk = (shown) =>
      waitFor(async () => (await page.locator("#as-role-ask").count()) === (shown ? 1 : 0), { timeoutMs: 10_000, what: `the inline row to be ${shown ? "shown" : "gone"}` });

    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-assistant", { timeout: 20_000 });
    await page.click("#btn-assistant");
    await page.waitForSelector("#assistant", { state: "visible" });
    await page.click('#as-tabs [data-as-tab="role"]');
    await page.waitForSelector("#as-role:not(.hidden)");
    await page.waitForFunction(() => !document.querySelector("#as-role-text").readOnly, null, { timeout: 15_000 });

    console.log("\n== the box opens on this assistant's copy ==");
    check("the picker offers the four roles as well as the seeded one", (await page.$$eval("#as-role-pick option", (els) => els.map((e) => e.value))).length, 5);
    check("…and the target selector offers both assistants", (await page.$$eval("#as-roletarget option", (els) => els.map((e) => e.value))), ["assistant-1", "assistant-2"]);
    check("…and starts on the role the assistant runs", await picker(), "agent-manager");
    check("the box holds the assistant's copy, byte for byte", await box(), seededBaseline);
    ok("…and says so", /this assistant's own copy/.test(await hold()), await hold());

    console.log("\n== a clean pick loads that role's own charter ==");
    await page.selectOption("#as-role-pick", "reviewer");
    ok("the box becomes the Reviewer's charter", await waitBox(reviewer), `${reviewer.length} chars`);
    ok("the description line is the picked role, in step with the box", /Reviewer — reads a diff and says no/.test(await remit()), await remit());
    check("the provenance line names the role's own text", /^the role's own text — not this assistant's copy yet$/.test(await hold()), true);
    ok("the sentence under the buttons says Save writes the COPY", /Save writes it to this assistant's copy, replacing the copy whole/.test(await saveLine()), await saveLine());
    check("…and the size is the role's", (await sizeLine()).split(" ")[0], `${reviewer.length}/20000`);
    let now = await roleOf();
    check("the pick changed the role title on the server", now.role.id, "reviewer");
    check("…but not one byte of this assistant's copy", now.charter.text, seededBaseline);
    check("…so the copy is not the role's text yet", now.sameAsRole, false);
    await shot("role-pick-clean.png");

    console.log("\n== Save writes what the box holds to the editing assistant's copy ==");
    await page.click("#btn-as-role");
    ok("the provenance flips to this assistant's own copy", await waitFor(async () => /^this assistant's own copy — the role's own text$/.test(await hold()), { timeoutMs: 10_000, what: "the copy to land" }), await hold());
    now = await roleOf();
    check("the copy on disk is the Reviewer's charter", now.charter.text, reviewer);
    check("…and it is the role's own text", now.sameAsRole, true);

    console.log("\n== a dirty box asks inline, and never loses the words ==");
    const typed = `${reviewer}\nMY OWN WORDS — NOT THE ROLE'S\n`;
    await page.fill("#as-role-text", typed);
    await page.selectOption("#as-role-pick", "second-role");
    ok("the inline row appears", await waitAsk(true));
    ok("…and no browser dialog did", dialogs.length === 0, `${dialogs.length} dialog(s)`);
    ok("…the box still holds the typed words", (await box()) === typed);
    ok("…saying why", /text you have not saved/.test(await askText()), (await askText()).replace(/\s+/g, " "));
    check("…with both answers", (await page.$$eval("#as-role-ask button", (els) => els.map((e) => e.innerText.trim()))), ["Keep mine", "Use the role's"]);
    check("the picker shows the change the reader made", await picker(), "second-role");
    check("the description line still describes the text on screen", /Reviewer — reads a diff and says no/.test(await remit()), true);
    now = await roleOf();
    check("no pick reached the server while the question waits", now.role.id, "reviewer");
    check("…and the copy was not written either", now.charter.text, reviewer);
    await shot("role-pick-dirty.png");

    console.log("\n== Keep mine keeps the words, and puts the picker back ==");
    await page.click('#as-role-ask [data-as-roleask="keep"]');
    ok("the row goes", await waitAsk(false));
    ok("the box still holds the typed words", (await box()) === typed);
    check("the picker is back on the role the assistant runs", await picker(), "reviewer");
    check("the description line is still that role", /Reviewer — reads a diff and says no/.test(await remit()), true);
    now = await roleOf();
    check("the server's role is unchanged", now.role.id, "reviewer");

    console.log("\n== switching which assistant is edited asks the same way ==");
    await page.selectOption("#as-roletarget", "assistant-2");
    ok("the inline row appears for the switch", await waitAsk(true));
    ok("…naming the assistant", /Switching to Assistant #2 would discard it/.test(await askText()), (await askText()).replace(/\s+/g, " "));
    ok("…the box keeps the typed words", (await box()) === typed);
    check("…and the selector shows the switch the reader made", await page.locator("#as-roletarget").inputValue(), "assistant-2");
    check("…with no browser dialog", dialogs.length, 0);
    await page.click('#as-role-ask [data-as-roleask="keep"]');
    ok("Keep mine keeps the editor on Assistant #1", await waitFor(async () => (await page.locator("#as-roletarget").inputValue()) === "assistant-1", { timeoutMs: 10_000, what: "the target selector to go back" }));
    ok("…and keeps the words", (await box()) === typed);

    console.log("\n== Use the role's discards the draft and loads the pick ==");
    await page.selectOption("#as-role-pick", "second-role");
    await waitAsk(true);
    await page.click('#as-role-ask [data-as-roleask="use"]');
    ok("the box becomes the Second Role's charter", await waitBox(second));
    ok("the description line follows it", /Second Role — a different job entirely/.test(await remit()), await remit());
    check("the provenance says the role's own text again", /^the role's own text — not this assistant's copy yet$/.test(await hold()), true);
    now = await roleOf();
    check("the server's role is the pick", now.role.id, "second-role");
    check("the copy is still the last saved Reviewer text", now.charter.text, reviewer);
    check("…so the box and the copy are different, and the tab says so", now.sameAsRole, false);

    console.log("\n== Adopt still works, and asks inline too ==");
    await page.click("#btn-as-role-adopt");
    ok("the inline row appears for the adopt as well", await waitAsk(true));
    ok("…naming what it replaces", /Adopting Second Role's charter replaces this assistant's copy/.test(await askText()), (await askText()).replace(/\s+/g, " "));
    check("…and no dialog did", dialogs.length, 0);
    await page.click('#as-role-ask [data-as-roleask="use"]');
    ok("the box holds the second charter", await waitBox(second));
    ok("…and the provenance is the assistant's copy of the role's text", await waitFor(async () => /^this assistant's own copy — the role's own text$/.test(await hold()), { timeoutMs: 10_000, what: "the adopted copy" }), await hold());
    now = await roleOf();
    check("the copy on disk is the Second Role's charter", now.charter.text, second);
    check("…and sameAsRole reads true", now.sameAsRole, true);

    console.log("\n== the cap: 19,773 loads clean, an edit past 20,000 warns before the press ==");
    await page.selectOption("#as-role-pick", "edge-role");
    ok("the 19,773-character charter lands in the box", await waitBox(edge), `${edge.length} chars`);
    ok("…with no cap warning", (await page.locator("#as-role-cap").count()) === 0);
    ok("…and Save is live", !(await saveDisabled()));
    await page.fill("#as-role-text", `${edge}${"y".repeat(300)}`);
    ok("crossing the cap grows the warning row", await waitFor(async () => (await page.locator("#as-role-cap").count()) === 1, { timeoutMs: 5_000, what: "the cap warning" }));
    const warn = await page.locator("#as-role-cap").innerText();
    ok("…with the numbers", /20,073 characters — 73 over the 20,000-character cap/.test(warn), warn);
    ok("…and Save is disabled before it can be pressed", await saveDisabled());
    check("…and the size line is marked bad", /is-bad/.test(await page.locator("#as-role [data-as-rolesize]").getAttribute("class")), true);
    // The keyboard path: force the disabled button and press it. The handler must refuse without a request, so the
    // copy on disk stays exactly what it was.
    await page.evaluate(() => {
      const b = document.querySelector("#btn-as-role");
      b.disabled = false;
      b.click();
    });
    ok("a forced press refuses with the cap's own words", await waitFor(async () => /the charter is 20073 characters and the cap is 20000/.test(await page.locator("#as-role-err").innerText()), { timeoutMs: 5_000, what: "the refusal" }), await page.locator("#as-role-err").innerText());
    now = await roleOf();
    check("…and wrote nothing", now.charter.text, second);
    await shot("role-pick-cap.png");
    await page.fill("#as-role-text", edge);
    ok("pruning under the cap clears the warning", await waitFor(async () => (await page.locator("#as-role-cap").count()) === 0, { timeoutMs: 5_000, what: "the warning to clear" }));
    ok("…and Save comes back alive", !(await saveDisabled()));

    console.log("\n== a role already over the cap warns the moment it lands ==");
    await page.selectOption("#as-role-pick", "overlong-role");
    ok("the over-cap charter lands", await waitBox(overlong), `${overlong.length} chars`);
    ok("…with the warning already up", (await page.locator("#as-role-cap").count()) === 1);
    ok("…naming the one character", /20,001 characters\s+—\s+1 over the 20,000-character cap/.test(await page.locator("#as-role-cap").innerText()), (await page.locator("#as-role-cap").innerText()).replace(/\s+/g, " "));
    ok("…and Save disabled", await saveDisabled());
    check("the provenance is still the role's own text", /^the role's own text — not this assistant's copy yet$/.test(await hold()), true);
    now = await roleOf();
    check("the copy was not written by merely loading it", now.charter.text, second);

    console.log("\n== the page's own health ==");
    check("no browser dialogs in the whole run", dialogs, []);
    check("no page errors", pageErrors, []);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a real panel process on its own port over its own PANEL_CONFIG and HERMES_HOME, four roles");
  console.log("created through its own route, and headless Chromium over it. The Role tab's picker, box, description line,");
  console.log("provenance line and Save were exercised: a clean pick, a save, a dirty pick answered both ways, an adopt, a");
  console.log("19,773-character role loaded clean, an edit across the 20,000 cap refused before a request, and an over-cap");
  console.log("role warned on landing. Browser dialogs: zero by counter, not by inspection.");
  if (!failures) console.log("ROLE-PICK-CHARTER-OK");
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
  if (process.env.VERIFY_KEEP === "1") console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  else rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (failures) process.exitCode = 1;
}
