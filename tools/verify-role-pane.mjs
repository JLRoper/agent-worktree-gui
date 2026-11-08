// THE ROLE TAB IS A ROLE EDITOR: one selector, three groups, one Save, and a write path for the ROLE's own charter.
//
//   node tools/verify-role-pane.mjs
//
// Driven in a real browser over a panel sandbox of its own. The brief took the per-assistant references out of this
// tab and gave it the save path it never had, so the gate proves both halves:
//
//   1. THE SHAPE: one #as-role-pick at the top; three .as-group blocks in ONE order (what the role is for -> the
//      prompt -> the charter), each with a single sentence and its own field(s); Save, Create role and New assistant
//      from this role together in one actions block at the bottom; and no per-assistant words on the pane at all -
//      no thread id, no "each assistant has its own copy", no Assistant #2-versus-#1 sentence, no preview.
//   2. THE READ: the boxes hold the ROLE the picker selects, byte for byte, read through
//      GET /api/assistant/role/charter - never an assistant's copy of it.
//   3. THE SAVE: editing name, description, prompt and charter and pressing Save writes THAT ROLE through
//      PUT /api/assistant/role/charter; the route, the picker's label, the library's list and a fresh read all agree,
//      and no assistant's charter file moved.
//   4. THE CAP: 20,001 characters warns before the press, disables Save, and a forced press refuses with no write;
//      pruning under it clears the warning.
//   5. THE PICK IS THE SUBJECT: choosing another role loads its four fields, editable; no assistant's record moves.
//   6. THE DIRTY GUARD: an unsaved edit is never silently replaced - the pick asks inline, Keep editing keeps the
//      words and puts the picker back, Switch loads the other role.
//   7. CREATE ROLE and NEW ASSISTANT FROM THIS ROLE still work from the role the editor shows.
//   8. THE ZOOM SHOTS: the tab at 100% and 150% (same 1500x1000 pixels), written where PANEL_VERIFY_ARTIFACTS says.
//   9. HEALTH: zero browser dialogs and zero page errors.
//
// HARNESS: LIVE GATE
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-role-pane-"));
let panel = null;
let browser = null;
const shots = [];
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

  const get = async (route) => {
    const r = await fetch(`${base}${route}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${route}: HTTP ${r.status} ${d.error || ""}`);
    return d;
  };
  const post = async (route, body) => {
    const r = await fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${route}: HTTP ${r.status} ${d.error || ""}`);
    return d;
  };
  const put = async (route, body) => {
    const r = await fetch(`${base}${route}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, body: d };
  };
  const roleOf = async (assistantId = "assistant-1") => await get(`/api/assistant/role?assistantId=${encodeURIComponent(assistantId)}`);
  const roleDoc = async (roleId) => await get(`/api/assistant/role/charter?roleId=${encodeURIComponent(roleId)}`);
  const rolesList = async () => await get("/api/roles");

  // The role library the pane sits in: one short reviewer, with a prompt of its own, and one role whose text is the
  // 19,773 the cap is measured against.
  const REVIEWER_TEXT = "# Reviewer charter\n\nREAD-THE-DIFF\n";
  const REVIEWER_PROMPT = "Read the diff before you answer, and never approve your own work.";
  const EDGE_TEXT = pad("# Edge role\n\n", 19_773);
  await post("/api/assistant/roles", { name: "Reviewer", description: "reads a diff and says no", prompt: REVIEWER_PROMPT, charter: REVIEWER_TEXT });
  await post("/api/assistant/roles", { name: "Edge Role", description: "sits just under the cap", charter: EDGE_TEXT });
  check("the edge charter sits at 19,773", EDGE_TEXT.length, 19_773);
  const seeded = await roleOf();
  const seededDoc = await roleDoc(seeded.role.id);
  ok("the editor's default role is the seeded manager, read whole", seededDoc.text.length > 1_000, `${seededDoc.text.length} chars`);
  check("…with an empty prompt until one is written", seededDoc.prompt, "");
  const charterBefore = (await get("/api/assistant/charter")).charter.text;

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
    page.on("dialog", async (d) => {
      dialogs.push(`${d.type()}: ${d.message()}`);
      await d.dismiss().catch(() => {});
    });
    const cdp = await context.newCDPSession(page);

    // The two zoom shots. Browser zoom makes the CSS viewport smaller and the device pixel ratio larger, so a 1500
    // px window at 150% lays the page out in 1000 CSS px and screenshots at 1500 px: the pair is the same picture at
    // two zooms, not two sizes.
    const shot = async (name, zoom = 1, where = "top") => {
      const into = process.env.PANEL_VERIFY_ARTIFACTS;
      if (!into) return null;
      mkdirSync(into, { recursive: true });
      if (zoom !== 1) {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: Math.round(1500 / zoom),
          height: Math.round(1000 / zoom),
          deviceScaleFactor: zoom,
          mobile: false,
        });
      }
      await page.evaluate((at) => {
        const pane = document.getElementById("as-role");
        const box = pane?.closest(".as-body") || pane?.parentElement;
        // The pane can be the scroller or sit inside one (the float's body), so both are aimed: whichever owns the
        // overflow lands on the bottom, and the other is a harmless 0.
        const to = at === "bottom" ? 1e6 : 0;
        if (pane) pane.scrollTop = to;
        if (box) box.scrollTop = to;
        if (at === "bottom") document.getElementById("btn-as-role")?.scrollIntoView({ block: "end" });
        else window.scrollTo(0, 0);
      }, where);
      // Read the layout back before the bytes: at 150% the CSS viewport must BE 1000 px wide, or the "zoom shot" is
      // just the 100% picture under another name. Capture through CDP too - Playwright's own screenshot reasserts
      // its viewport and silently undoes this override.
      const layout = await page.evaluate(() => window.innerWidth);
      check(`a ${zoom * 100}% shot lays the page out in ${Math.round(1500 / zoom)} CSS px`, layout, Math.round(1500 / zoom));
      const file = path.join(into, name);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(file, Buffer.from(data, "base64"));
      shots.push({ file, zoom });
      if (zoom !== 1) await cdp.send("Emulation.clearDeviceMetricsOverride");
      note(`screenshot at ${zoom * 100}%: ${file}`);
      return file;
    };

    const textOf = async (sel) => ((await page.locator(sel).count()) ? page.locator(sel).innerText() : "");
    const valueOf = (sel) => page.locator(sel).inputValue();
    const saveDisabled = () => page.locator("#btn-as-role").isDisabled();
    const groupHeads = () => page.$$eval("#as-role .as-group h4", (els) => els.map((e) => e.innerText.trim()));
    const groupSentences = () => page.$$eval("#as-role .as-group .as-help", (els) => els.map((e) => e.innerText.trim()));
    const openRole = async () => {
      if (!(await page.locator("#as-role:not(.hidden)").count())) await page.click('#as-tabs [data-as-tab="role"]');
      await page.waitForSelector("#as-role:not(.hidden)");
      await page.waitForFunction(() => {
        const n = document.querySelector("#as-role-name");
        return Boolean(n && !n.disabled && document.querySelector("#as-role-pick")?.value);
      }, null, { timeout: 15_000 });
    };
    const picker = () =>
      page.locator("#as-role-pick").evaluate((el) => ({
        value: el.value,
        options: [...el.options].map((o) => ({ value: o.value, label: o.textContent.trim() })),
      }));

    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-assistant", { timeout: 20_000 });
    await page.click("#btn-assistant");
    await page.waitForSelector("#assistant", { state: "visible" });
    await openRole();

    console.log("\n== 1. one selector, three groups in order, one sentence each, and the presses at the bottom ==");
    check("one role selector", await page.locator("#as-role-pick").count(), 1);
    check("…at the top of the pane", await page.evaluate(() => document.querySelector("#as-role-pick").getBoundingClientRect().top < document.querySelector("#as-role .as-group").getBoundingClientRect().top), true);
    check("three groups", await page.locator("#as-role .as-group").count(), 3);
    check("their order", (await groupHeads()).map((h) => h.toLowerCase()), ["what this role is for", "the prompt", "the charter"]);
    const sentences = await groupSentences();
    check("one sentence per group", sentences.map((s) => (s.match(/\./g) || []).length), [1, 1, 1]);
    ok("the first says what the role is for, in its name and description", /name/.test(sentences[0]) && /description/.test(sentences[0]), sentences[0]);
    ok("the second says the prompt is the short instruction", /prompt/.test(sentences[1]) && /short instruction/.test(sentences[1]), sentences[1]);
    ok("the third says when the charter is sent", /first turn/.test(sentences[2]) && /every twentieth turn/.test(sentences[2]), sentences[2]);
    check("the four editable fields", await page.locator("#as-role-name, #as-role-description, #as-role-prompt, #as-role-text").count(), 4);
    const actions = await page.$$eval("#as-role .as-actions button", (els) => els.map((e) => e.id));
    check("the presses, grouped at the bottom", actions, ["btn-as-role", "btn-as-role-newrole", "btn-as-new-assistant"]);
    check("…in the pane's last block", await page.evaluate(() => [...document.querySelectorAll("#as-role > *")].pop().classList.contains("as-actions")), true);
    const whole = (await textOf("#as-role")).toLowerCase();
    for (const gone of ["thread", "own copy", "each assistant", "assistant #2", "preview", "read-only"]) {
      ok(`no per-assistant "${gone}" on the pane`, !whole.includes(gone), whole.includes(gone) ? "found" : "absent");
    }
    check("…and no second picker or adopt control", await page.locator("#as-role [data-as-roletarget], #as-role #btn-as-role-adopt").count(), 0);

    console.log("\n== 2. the boxes hold the ROLE the picker shows, read from the role's own save path ==");
    const picked0 = await picker();
    check("the selector is on the role the default resolves to", picked0.value, seeded.role.id);
    ok("…named in the library's words", picked0.options.some((o) => o.value === seeded.role.id && o.label === "Agent Manager"), JSON.stringify(picked0.options));
    check("the name box is the role's name", await valueOf("#as-role-name"), seededDoc.role.name);
    check("…the description box its remit", await valueOf("#as-role-description"), seededDoc.role.description);
    ok("…the charter box its text, byte for byte", (await page.locator("#as-role-text").evaluate((el) => el.value)) === seededDoc.text, `${seededDoc.text.length} chars`);
    ok("…and the size line is judged against the cap", new RegExp(`^${seededDoc.text.length}/20000 chars`).test(await textOf("#as-role [data-as-rolesize]")), await textOf("#as-role [data-as-rolesize]"));

    console.log("\n== 3. Save writes the ROLE, through PUT /api/assistant/role/charter ==");
    const SAVED = {
      name: "Manager Prime",
      description: "drives every agent it starts to an approved PR, and says what it is waiting on",
      prompt: "Be brief. Say what you changed, and never approve your own work.",
      text: "# The manager charter, rewritten\n\nSAVED-ON-THE-ROLE\n",
    };
    await page.fill("#as-role-name", SAVED.name);
    await page.fill("#as-role-description", SAVED.description);
    await page.fill("#as-role-prompt", SAVED.prompt);
    await page.fill("#as-role-text", SAVED.text);
    ok("a draft is called a draft", /edited here, not saved/.test(await textOf("#as-role [data-as-roleholds]")), await textOf("#as-role [data-as-roleholds]"));
    ok("…and Save is live under the cap", !(await saveDisabled()));
    await page.click("#btn-as-role");
    ok(
      "the four fields land on the ROLE",
      await waitFor(
        async () => {
          const d = await roleDoc(seeded.role.id);
          return d.role.name === SAVED.name && d.role.description === SAVED.description && d.prompt === SAVED.prompt && d.text === SAVED.text;
        },
        { timeoutMs: 15_000, what: "the role's save" },
      ),
    );
    const afterSave = await roleDoc(seeded.role.id);
    check("…in ONE record", [afterSave.role.name, afterSave.role.description, afterSave.prompt, afterSave.text], [SAVED.name, SAVED.description, SAVED.prompt, SAVED.text]);
    ok("…and a fresh read of the library carries the new name", (await rolesList()).roles.some((r) => r.id === seeded.role.id && r.name === SAVED.name));
    ok("…with the picker's label following it", await waitFor(async () => /Manager Prime/.test(await page.locator("#as-role-pick option:checked").innerText()), { timeoutMs: 10_000, what: "the picker label" }), await page.locator("#as-role-pick option:checked").innerText());
    ok("…the provenance back on disk", /the role's own text/.test(await textOf("#as-role [data-as-roleholds]")), await textOf("#as-role [data-as-roleholds]"));
    ok("…and no assistant's charter file was touched", (await get("/api/assistant/charter")).charter.text === charterBefore, `${charterBefore.length} chars`);
    check("a PUT with an unknown role id is a 404", (await put("/api/assistant/role/charter", { roleId: "no-such-role", name: "x", text: "" })).status, 404);
    check("a PUT with no name is a 400", (await put("/api/assistant/role/charter", { roleId: seeded.role.id, name: "  ", text: "x" })).status, 400);

    await shot("role-tab-100.png", 1);
    await shot("role-tab-150.png", 1.5);
    await shot("role-tab-150-bottom.png", 1.5, "bottom");

    console.log("\n== 4. the cap warns before the press, refuses a forced one, and clears when pruned ==");
    await page.fill("#as-role-text", EDGE_TEXT);
    ok("19,773 characters leave Save live", !(await saveDisabled()));
    check("…and no warning", await page.locator("#as-role-cap").count(), 0);
    await page.fill("#as-role-text", `${EDGE_TEXT}${"y".repeat(300)}`);
    ok("crossing the cap grows the warning", await waitFor(async () => (await page.locator("#as-role-cap").count()) === 1, { timeoutMs: 5_000, what: "the cap warning" }));
    const warn = await textOf("#as-role-cap");
    ok("…with the numbers", /20,073 characters/.test(warn) && /73 over the 20,000-character cap/.test(warn), warn.replace(/\s+/g, " "));
    ok("…and Save disabled before the press", await saveDisabled());
    await page.evaluate(() => {
      const b = document.querySelector("#btn-as-role");
      b.disabled = false;
      b.click();
    });
    ok(
      "a forced press refuses with the cap's own words",
      await waitFor(async () => /the charter is 20073 characters and the cap is 20000/.test(await textOf("#as-role-err")), { timeoutMs: 5_000, what: "the refusal" }),
      await textOf("#as-role-err"),
    );
    check("…and wrote nothing", (await roleDoc(seeded.role.id)).text.length, SAVED.text.length);
    await page.fill("#as-role-text", EDGE_TEXT);
    ok("pruning under the cap clears the warning", await waitFor(async () => (await page.locator("#as-role-cap").count()) === 0, { timeoutMs: 5_000, what: "the warning to clear" }));
    ok("…and Save comes back", !(await saveDisabled()));
    await page.click("#btn-as-role");
    ok(
      "…and the 19,773-character charter saves whole",
      await waitFor(async () => (await roleDoc(seeded.role.id)).text === EDGE_TEXT, { timeoutMs: 15_000, what: "the big save to land" }),
      `${EDGE_TEXT.length} chars`,
    );
    ok(
      "…and the pane repaints from the role it wrote",
      await waitFor(async () => /read .* ago/.test(await textOf("#as-role [data-as-rolesave]")), { timeoutMs: 10_000, what: "the save repaint" }),
      await textOf("#as-role [data-as-rolesave]"),
    );

    console.log("\n== 5. a pick is the SUBJECT: the other role's four fields, editable, and no assistant moves ==");
    const beforePick = await roleOf();
    await page.selectOption("#as-role-pick", "reviewer");
    ok(
      "the boxes become the Reviewer's own fields",
      await waitFor(
        async () =>
          (await valueOf("#as-role-name")) === "Reviewer" &&
          (await valueOf("#as-role-description")) === "reads a diff and says no" &&
          (await valueOf("#as-role-prompt")) === REVIEWER_PROMPT &&
          (await page.locator("#as-role-text").evaluate((el) => el.value)) === REVIEWER_TEXT,
        { timeoutMs: 15_000, what: "the Reviewer read" },
      ),
    );
    ok("…and they are editable, not a read-only preview", !(await page.locator("#as-role-name").evaluate((el) => el.disabled || el.readOnly)));
    ok("…with Save live", !(await saveDisabled()));
    check("…while no assistant's role moved", (await roleOf()).role.id, beforePick.role.id);
    ok("…and its copy is untouched", (await roleOf()).charter.text === beforePick.charter.text, `${beforePick.charter.text.length} chars`);

    console.log("\n== 6. an unsaved edit is asked about, never silently replaced ==");
    await page.fill("#as-role-name", "Reviewer of Diffs");
    await page.selectOption("#as-role-pick", "edge-role");
    ok("the pick asks inline", await waitFor(async () => (await page.locator("#as-role-ask").count()) === 1, { timeoutMs: 5_000, what: "the inline question" }));
    ok("…naming the role it would switch to", /Edge Role/.test(await textOf("#as-role-ask")), (await textOf("#as-role-ask")).slice(0, 120));
    ok("…and the words stay on screen", (await valueOf("#as-role-name")) === "Reviewer of Diffs");
    await page.click('#as-role-ask [data-as-roleask="keep"]');
    ok("Keep editing keeps the words", (await valueOf("#as-role-name")) === "Reviewer of Diffs");
    check("…and puts the picker back", (await picker()).value, "reviewer");
    await page.selectOption("#as-role-pick", "edge-role");
    await page.waitForSelector("#as-role-ask");
    await page.click('#as-role-ask [data-as-roleask="switch"]');
    ok("Switch loads the other role", await waitFor(async () => (await valueOf("#as-role-name")) === "Edge Role", { timeoutMs: 15_000, what: "the Edge Role read" }), await valueOf("#as-role-name"));

    console.log("\n== 7. Create role copies the role shown; New assistant from this role starts one on it ==");
    await page.click("#btn-as-role-newrole");
    const copy = await waitFor(
      async () => {
        const list = await rolesList();
        return list.roles.find((r) => r.name === "Edge Role copy") || null;
      },
      { timeoutMs: 15_000, what: "the copied role" },
    );
    ok("Create role adds a copy to the library", Boolean(copy), copy?.id);
    ok("…and opens it in the editor", await waitFor(async () => (await picker()).value === copy.id, { timeoutMs: 15_000, what: "the editor to follow the copy" }));
    ok("…with the role's text copied", (await roleDoc(copy.id)).text === EDGE_TEXT, `${EDGE_TEXT.length} chars`);
    await page.fill("#as-role-name", "Third Role");
    await page.click("#btn-as-role");
    ok("…and the copy can be renamed and saved", await waitFor(async () => (await roleDoc(copy.id)).role.name === "Third Role", { timeoutMs: 15_000, what: "the copy's rename" }));

    await page.click("#btn-as-new-assistant");
    ok(
      "New assistant from this role adds Assistant #2",
      await waitFor(async () => (await page.locator('#as-tabs [data-as-tab="assistant-2"]').count()) === 1, { timeoutMs: 15_000, what: "Assistant #2's tab" }),
    );
    const second = await waitFor(
      async () => {
        const d = await roleOf("assistant-2").catch(() => null);
        return d && d.role?.id === copy.id ? d : null;
      },
      { timeoutMs: 15_000, what: "#2's role" },
    );
    check("…running the role the editor showed", second.role.id, copy.id);
    ok("…with the role's charter as its own copy", second.charter.text === EDGE_TEXT, `${EDGE_TEXT.length} chars`);
    ok("…and the role the editor showed was not changed by it", (await roleDoc(copy.id)).text === EDGE_TEXT, `${EDGE_TEXT.length} chars`);

    console.log("\n== 8. the zoom shots ==");
    check("a 100% shot was written", shots.filter((s) => s.zoom === 1).length, 1);
    check("a 150% shot was written", shots.filter((s) => s.zoom === 1.5).length, 2);
    if (shots.length) {
      for (const s of shots) note(`${s.zoom * 100}%: ${s.file}`);
    } else {
      note("PANEL_VERIFY_ARTIFACTS was not set, so no screenshot was written");
    }

    console.log("\n== 9. the page's own health ==");
    check("no browser dialogs in the whole run", dialogs, []);
    check("no page errors", pageErrors, []);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a real panel process on its own port over its own PANEL_CONFIG and HERMES_HOME, two roles");
  console.log("created through its own route, and headless Chromium over it. The Role tab's shape (one selector, three");
  console.log("groups, one sentence each, the presses at the bottom), the role's own read and PUT save, the cap warning and");
  console.log("its forced-press refusal, the pick as the subject, the dirty guard, Create role and New assistant from this");
  console.log("role were all exercised. Browser dialogs: zero by counter, not by inspection.");
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
