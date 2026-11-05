// The assistant reset control, driven in a real Chromium — the five copy states, each painted from the REAL route.
//
//   node tools/verify-assistant-reset-ui.mjs [--shots <dir>]
//
// WHAT IS DRIVEN
//   * the control is the THIRD control in the Settings → Gateway restart row: a select (whose assistant), a button,
//     and its own #reset-preview line under the restart line — never the restart line's answer overwritten;
//   * the select is hidden while there is one assistant and shows every assistant (id in the option's title) once
//     there are two, and the button's title always names whose reset it is;
//   * the press is TWO presses: the first sends { dryRun: true } and paints the rows it would clear (one per
//     admission, one per watch, one per wake, then the keeps line), the second sends the real call;
//   * and the five states, each reached by a real request to POST /api/assistants/assistant-2/reset:
//       dry run    — "would clear 1 admission", the run/admission/generation/card row, "would drop 2 watches"
//       blocked    — 409 assistant_live: "still executing", painted .bad, and the button DISARMS (a second press
//                    would ask the same question)
//       refused    — 409 fence_unclearable: "no card here names", the admission row, `hermes --resume <thread>`
//       success    — the second press: "reset — Assistant #2", the receipt's `interrupted`, the resume path, one
//                    resolve at the gateway with both ids and the run's watches gone from the assistant
//       incomplete — a failed resolve: "reset INCOMPLETE", the resume path, the watches kept
//
// RED PROOF. On a `git archive origin/main | tar -x` export there is no #btn-reset-assistant and no reset route, so
// the first press check fails and the run exits 1 — the five states are not passed by an empty page. Playwright is
// optional: absent, the file prints BROWSER-HALF-NOT-RUN and exits 2.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, openSettingsGroup, withBrowser } from "./browser.mjs";
import { ASSISTANT, THREAD, bootResetSandbox, createAssistantTwo, insertRows, setRow } from "./reset-harness.mjs";

const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : null;

let failures = 0;
let checks = 0;
const check = (cond, label, detail = "") => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
};
const note = (text) => console.log(`      ${text}`);

const previewText = (page) => page.evaluate(() => document.getElementById("reset-preview")?.textContent || "");
const button = (page) =>
  page.evaluate(() => {
    const b = document.getElementById("btn-reset-assistant");
    return b ? { text: b.textContent, armed: b.dataset.armed || "", disabled: b.disabled, title: b.title } : null;
  });
const waitPreview = (page, needle) =>
  page.waitForFunction((n) => (document.getElementById("reset-preview")?.textContent || "").includes(n), needle, { timeout: 25_000 });

async function openGateway(page) {
  await openSettingsGroup(page, "gateway");
  await page.waitForSelector("#restart-row", { state: "visible", timeout: 10_000 });
}

const state = (page) =>
  page.evaluate(() => {
    const row = document.getElementById("restart-row");
    const sel = document.getElementById("reset-assistant");
    const prev = document.getElementById("reset-preview");
    return {
      rowExists: Boolean(row),
      childControls: row ? [...row.querySelectorAll("button, select")].map((el) => el.id) : [],
      selectHidden: Boolean(sel?.hidden),
      options: sel ? [...sel.querySelectorAll("option")].map((o) => ({ value: o.value, label: o.textContent, title: o.title })) : [],
      chosen: sel?.value || "",
      previewNext: Boolean(prev && prev.previousElementSibling && prev.previousElementSibling.id === "restart-preview"),
      previewBad: Boolean(prev && prev.classList.contains("bad")),
      whiteSpace: prev ? getComputedStyle(prev).whiteSpace : null,
      lineCount: prev ? String(prev.textContent || "").split("\n").length : 0,
    };
  });

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the assistant reset control", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });

  const box = await bootResetSandbox({ keep: true });
  const { panel, gateway, stateDb, token } = box;
  try {
    console.log(`sandbox: ${panel.base}`);
    await withBrowser(
      async ({ page, pageErrors }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await openPage(page, panel.base, { selector: "#btn-settings" });
        await openGateway(page);

        // ---- 0. one assistant: the select is hidden, and the button names it ---------------------------------
        const one = await state(page);
        check(one.rowExists, "the restart row is in the Gateway tab");
        check(JSON.stringify(one.childControls) === JSON.stringify(["btn-restart-gateway", "btn-restart-panel", "reset-assistant", "btn-reset-assistant"]),
          "the reset is the THIRD control, after the two restarts", one.childControls.join(","));
        check(one.previewNext, "#reset-preview sits under the restart line and does not replace it");
        check(one.selectHidden, "with one assistant the select is hidden");
        check(one.options.length === 1 && one.chosen === "assistant-1", "the one option is Assistant #1", JSON.stringify(one.options));
        const firstButton = await button(page);
        check(/^Reset Assistant #1/.test(firstButton?.title || ""), "the button's title names whose reset it is", firstButton?.title);

        // ---- assistant #2, through the panel's own route ---------------------------------------------------
        const { response: created, rec: two } = await createAssistantTwo(panel, token);
        check(created.status === 201 && two?.threadId === THREAD, "Assistant #2 exists, on its own thread", `${created.status} · ${two?.threadId}`);
        await fetch(`${panel.base}/api/assistant/watch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-panel-token": token },
          body: JSON.stringify({ thread: "wtgui-a-worker-1a2b3c", title: "the queue fix is pushed", assistantId: ASSISTANT }),
        });
        await fetch(`${panel.base}/api/assistant/watch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-panel-token": token },
          body: JSON.stringify({ thread: THREAD, title: "its own turn finished", assistantId: ASSISTANT }),
        });

        await page.reload({ waitUntil: "domcontentloaded" });
        await openGateway(page);
        await page.waitForSelector("#reset-assistant", { state: "visible", timeout: 10_000 });
        await page.selectOption("#reset-assistant", ASSISTANT);
        const two2 = await state(page);
        check(!two2.selectHidden, "with two assistants the select is shown");
        check(two2.options.length === 2 && two2.chosen === ASSISTANT, "both assistants are options and #2 can be chosen", JSON.stringify(two2.options));
        check(two2.options.every((o) => /panel-assistant/.test(o.title)), "each option's title carries its Hermes thread id", JSON.stringify(two2.options.map((o) => o.title)));
        check(/^Reset Assistant #2/.test((await button(page))?.title || ""), "the button follows the select and names Assistant #2");

        // ---- 1. dry run ----------------------------------------------------------------------------------
        let before = gateway.posts();
        await page.click("#btn-reset-assistant");
        await waitPreview(page, "would clear 1 admission");
        const dry = await previewText(page);
        const dryState = await state(page);
        check(dry.includes(`Assistant #2 · ${THREAD}`), "the dry run names the assistant and its thread", dry.split("\n")[0]);
        check(dry.includes("run run_1") && dry.includes("admission adm_1") && dry.includes("generation 1") && dry.includes("card card_1"),
          "the admission row names the run, admission, generation and card", dry.split("\n")[1] || "");
        check(dry.includes("would drop 2 watches"), "one section per kind, with the count", (dry.match(/would drop .*/) || [""])[0]);
        check(dry.includes("wtgui-a-worker-1a2b3c") && dry.includes("its own turn finished"), "each watch is its own row (a worker's and its own)");
        check(/keeps: 0 queue rows · \d+ notes · \d+ rules · charter \d+ chars/.test(dry), "the keeps line counts what is kept");
        check(dry.includes("press again to reset"), "the copy says the second press is the reset");
        check(dryState.whiteSpace === "pre-wrap" && dryState.lineCount > 6, "the preview is painted row by row, not folded into a paragraph", `${dryState.whiteSpace} · ${dryState.lineCount} lines`);
        check(!dryState.previewBad, "a clearable dry run is not painted as a refusal");
        const armed = await button(page);
        check(armed.text === "reset Assistant #2?" && armed.armed === "1", "the first press arms the button and says whose reset is waiting", `${armed.text} · armed=${armed.armed}`);
        check(gateway.posts() - before === 0, "a dry run sends no POST to the gateway", `${gateway.posts() - before} resolve(s)`);
        if (shotsDir) {
          await page.locator("#restart-row").screenshot({ path: path.join(shotsDir, "reset-row.png") });
          await page.locator("#reset-preview").screenshot({ path: path.join(shotsDir, "reset-state-dry-run.png") });
        }

        // ---- 2. blocked: 409 assistant_live -----------------------------------------------------------------
        gateway.state.runs.run_2.status = "started";
        before = gateway.posts();
        await page.reload({ waitUntil: "domcontentloaded" });
        await openGateway(page);
        await page.selectOption("#reset-assistant", ASSISTANT);
        await page.click("#btn-reset-assistant");
        await waitPreview(page, "still executing");
        const blocked = await previewText(page);
        const blockedState = await state(page);
        check(blocked.includes("run_2") && blocked.includes("still executing"), "blocked: the route's own sentence names the live run", blocked.split("\n")[0]);
        check(blocked.includes("nothing was cleared"), "blocked: it says nothing was cleared");
        check(blockedState.previewBad, "blocked: the preview is painted .bad");
        const afterBlocked = await button(page);
        check(afterBlocked.armed === "" && afterBlocked.text === "Reset assistant", "blocked: the refusal disarms the button (a second press would ask the same question)");
        check(gateway.posts() - before === 0, "blocked: nothing was sent to the gateway");
        if (shotsDir) await page.locator("#reset-preview").screenshot({ path: path.join(shotsDir, "reset-state-blocked.png") });
        gateway.state.runs.run_2.status = "cancelled";

        // ---- 3. refused: 409 fence_unclearable ---------------------------------------------------------------
        setRow(stateDb, "adm_1");
        insertRows(stateDb, [{ admissionId: "adm_gone", requestId: "run_gone", threadId: THREAD, generation: 63, ownerEpoch: 18 }]);
        before = gateway.posts();
        await page.reload({ waitUntil: "domcontentloaded" });
        await openGateway(page);
        await page.selectOption("#reset-assistant", ASSISTANT);
        await page.click("#btn-reset-assistant");
        await waitPreview(page, "no card here names");
        const refused = await previewText(page);
        const refusedState = await state(page);
        check(refused.includes("adm_gone") && refused.includes("generation 63"), "refused: it carries the admission and generation it could not name");
        check(refused.includes(`hermes --resume ${THREAD}`), "refused: the copy names the resume command with the real thread");
        check(refusedState.previewBad, "refused: the preview is painted .bad");
        check(gateway.posts() - before === 0, "refused: nothing was sent to the gateway");
        if (shotsDir) await page.locator("#reset-preview").screenshot({ path: path.join(shotsDir, "reset-state-refused.png") });
        setRow(stateDb, "adm_gone");
        setRow(stateDb, "adm_1", { status: "unknown", outcome: null });

        // ---- 4. success: the second press --------------------------------------------------------------------
        before = gateway.posts();
        await page.reload({ waitUntil: "domcontentloaded" });
        await openGateway(page);
        await page.selectOption("#reset-assistant", ASSISTANT);
        await page.click("#btn-reset-assistant");
        await waitPreview(page, "would clear 1 admission");
        await page.click("#btn-reset-assistant");
        await waitPreview(page, "reset — Assistant #2");
        const success = await previewText(page);
        const successState = await state(page);
        check(success.includes("1 admission settled (interrupted"), "success: the receipt's outcome is reported", success.split("\n")[0]);
        check(success.includes("the projection now reads cancelled"), "success: the projection's other word is reported, not conflated");
        check(success.includes("2 watches dropped"), "success: the watches it dropped are counted");
        check(success.includes("If a panel turn is still refused with 409 permission_denied"), "success: it names the other fence before the reader meets it");
        check(success.includes(`continue it with hermes --resume ${THREAD}`), "success: the resume command carries the real thread id");
        check(!successState.previewBad, "success: the preview is not painted as a refusal");
        check(gateway.posts() - before === 1, "success: exactly one resolve reached the gateway", `${gateway.posts() - before}`);
        const sent = gateway.state.resolveCalls.at(-1);
        check(
          sent?.runId === "run_1" && JSON.stringify(sent?.body) === JSON.stringify({ admission_id: "adm_1", execution_generation: 1 }),
          "success: the body is exactly {admission_id, execution_generation} for the run the card names",
          JSON.stringify(sent?.body),
        );
        const assistantNow = await (await fetch(`${panel.base}/api/assistant`)).json();
        check(!(assistantNow.watches || []).some((w) => w.assistantId === ASSISTANT), "success: Assistant #2's watches are gone from the assistant");
        const afterSuccess = await button(page);
        check(afterSuccess.disabled === false && afterSuccess.text === "Reset assistant", "success: the button is pressable again and disarmed");
        if (shotsDir) await page.locator("#reset-preview").screenshot({ path: path.join(shotsDir, "reset-state-success.png") });

        // ---- 5. incomplete: a failed resolve leaves the fence standing -----------------------------------------
        insertRows(stateDb, [
          { admissionId: "adm_3", requestId: "run_3", threadId: THREAD, generation: 7 },
          { admissionId: "adm_4", requestId: "run_gone_2", threadId: THREAD, generation: 64 },
        ]);
        await fetch(`${panel.base}/api/assistant/watch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-panel-token": token },
          body: JSON.stringify({ thread: THREAD, title: "a watch that must survive", assistantId: ASSISTANT }),
        });
        gateway.state.failResolve.add("run_3");
        await page.reload({ waitUntil: "domcontentloaded" });
        await openGateway(page);
        await page.selectOption("#reset-assistant", ASSISTANT);
        await page.click("#btn-reset-assistant");
        await waitPreview(page, "would clear 1 admission");
        const blockedDry = await previewText(page);
        check(blockedDry.includes("blocked: 1 admission no card here names") && blockedDry.includes("report incomplete"),
          "a partly unnameable dry run says which row cannot be settled and what the press will report");
        await page.click("#btn-reset-assistant");
        await waitPreview(page, "reset INCOMPLETE");
        const incomplete = await previewText(page);
        const incompleteState = await state(page);
        check(/0 of 1 admission\(s\) cleared/.test(incomplete), "incomplete: it says how many cleared", (incomplete.match(/0 of 1[^;]*/) || [""])[0]);
        check(incomplete.includes("still fenced"), "incomplete: it says the session is still fenced");
        check(incomplete.includes(`hermes --resume ${THREAD}`), "incomplete: the resume command carries the real thread id");
        check(incomplete.includes("does not replay the lost turn"), "incomplete: it says what resume does not do");
        check(incompleteState.previewBad, "incomplete: the preview is painted .bad");
        const kept = await (await fetch(`${panel.base}/api/assistant`)).json();
        check((kept.watches || []).some((w) => w.assistantId === ASSISTANT), "incomplete: the watch is kept while the fence stands");
        if (shotsDir) await page.locator("#reset-preview").screenshot({ path: path.join(shotsDir, "reset-state-incomplete.png") });

        check(pageErrors.length === 0, "the page threw nothing while the five states were driven", pageErrors.slice(0, 3).join(" | "));
      },
      { viewport: { width: 1400, height: 900 } },
    );
  } finally {
    const log = await box.stop();
    if (failures) note(`panel log (tail):\n${log.split("\n").slice(-20).join("\n")}`);
    console.log(`\n${checks - failures}/${checks} checks passed`);
    process.exitCode = failures ? 1 : 0;
  }
}

await main();
