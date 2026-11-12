// The console's prose, proved in a real browser against THIS checkout's public/**: the agent's markdown arrives as
// shapes (a), a fenced block is a labelled well that counts its lines and folds past fifteen (b), the raw toggle
// hands the reader the turn's own bytes back (c), and focus hides the tool rows while keeping the prose, the error
// and the final message (d).
//
//   node tools/verify-console-render.mjs
//   CONSOLE_VIEWPORT_WIDTH=480 node tools/verify-console-render.mjs           # the same gate at the docked rail
//   PANEL_ROOT=<an extracted git archive> node tools/verify-console-render.mjs   # the failing-first proof
//
// WHAT IS SEEDED, AND WHY IT IS A REAL RENDER
//
//   A sandbox panel of its own on a spare port (never 7331, and apiServer pinned at a dead port so nothing here can
//   buy a worker), with one finished turn written into its own logs/jobs.json BEFORE it boots — the transcript a run
//   really leaves: prose with `**`, backticks and `***`, a heading, a bullet list, a tool call with its result, a
//   twenty-line fenced block, a run-level error line and a final sentence. The page is then driven through the
//   shipped snapshot -> renderJobs -> turnBody path, so every shape under test is the real renderer's.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven   a real click on the fence's own button (the body's `hidden`, its aria-expanded and the caret all read
//            back after it), a real click on the raw toggle (the console's textContent compared, character for
//            character, with the seed) and a second click back to the rendered view, and a real click on focus
//            (the tool group's computed display, the error line's own box, the prose and the last block)
//   inspected that the source line, not the rendered text, is what `data-ltext` carries — so a rebuild reads back
//            what the turn said (a DOM read, not a source grep)
//
// THE RED PROOF
//
//   `PANEL_ROOT` points the same harness at another checkout — the panel it boots is THAT root's server.js, serving
//   THAT root's public/**, while the assertions stay here. Extract the base and run it there:
//
//     git archive origin/main | tar -x -C "$SCRATCH/base"
//     cd "$SCRATCH/base" && git init -q -b main && git add -A && git commit -q -m export
//     PANEL_ROOT="$SCRATCH/base" node tools/verify-console-render.mjs
//
//   The base has no markdown module, no `.md-block`, no raw/focus control and no fence well, so every section below
//   FAILs and the exit code is non-zero — which is what makes this gate a gate. (The archive needs its own one-commit
//   repository: server.js reads HEAD for the build version, and an export without `.git` dies before it serves.)
//
//   Without a Playwright install this prints BROWSER-HALF-NOT-RUN, counts a failure and exits non-zero rather than
//   passing a half that never ran.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The checkout whose public/** the sandbox serves. This tree by default; `PANEL_ROOT` is the failing-first proof.
const ROOT = process.env.PANEL_ROOT ? path.resolve(process.env.PANEL_ROOT) : path.join(HERE, "..");
// The reader's window. 1360x980 is the panel's own default; the same gate is run at the docked rail's width
// (`CONSOLE_VIEWPORT_WIDTH=480`, style.css calls that rail 480px) so a shape that only fits wide is caught here.
const VIEWPORT = {
  width: Number(process.env.CONSOLE_VIEWPORT_WIDTH) || 1360,
  height: Number(process.env.CONSOLE_VIEWPORT_HEIGHT) || 980,
};

let failures = 0;
let checks = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
  return Boolean(cond);
};
const said = (label, value) => console.log(`      ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

// ---- the transcript this gate seeds ---------------------------------------------------------------
// A twenty-line fenced block is the one that has to fold (the fold is at fifteen), and the prose around it carries
// every inline marker the console used to print raw.
const FENCE_LINES = Array.from({ length: 20 }, (_, i) => `+ echo "step ${i + 1}"`);
const SEED = [
  { kind: "text", text: "**PR #279 MERGED** on `origin/main` — ***finally***." },
  { kind: "text", text: "## What landed" },
  { kind: "text", text: "The fix is in and the run is green. [the PR](https://example.test/pr/279) reads merged." },
  { kind: "text", text: "- the console renders the agent's prose" },
  { kind: "text", text: "- the raw view keeps the bytes" },
  { kind: "tool", text: "🔧 terminal · git log --oneline -3" },
  { kind: "tool-out", text: "  ↳ terminal · 0.42s" },
  { kind: "tool-out", text: "4ba624e chore: 0.77.2 — the patch over main's 0.77.1" },
  { kind: "text", text: "```sh" },
  ...FENCE_LINES.map((text) => ({ kind: "text", text })),
  { kind: "text", text: "```" },
  { kind: "raw", text: "error: the run's last step exited 3 — nothing was pushed" },
  { kind: "text", text: "Final: the branch is landed, and the pull request reads **MERGED**." },
];
const SEED_TEXT = SEED.map((line) => line.text).join("\n");
const THREAD = "wtgui-probe-console-render-7c31d2";
const JOB_ID = "j-console-render";

function seedJob() {
  const start = Date.now() - 120_000;
  return {
    id: JOB_ID,
    thread: THREAD,
    turn: 1,
    prompt: "console render probe",
    displayPrompt: "console render probe",
    cwd: null,
    ownerPath: null,
    projectPath: null,
    sessionId: THREAD,
    status: "done",
    exitCode: 0,
    runId: "run_probe_console_render",
    worktree: false,
    worktreePath: null,
    branch: null,
    model: "probe/model",
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + 40_000).toISOString(),
    finalMessage: SEED[SEED.length - 1].text,
    lines: SEED.map((line, i) => ({ ...line, lid: i + 1, at: start + i * 100 })),
    artifacts: [],
    attachments: [],
    subagents: [],
  };
}

// ---- the run --------------------------------------------------------------------------------------
let panel = null;
let browserResult = null;

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-console-render-"));
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), jobs: [seedJob()] }), "utf8");
  console.log(`\n== the sandbox: its own panel on its own port, serving ${ROOT}`);
  panel = await startPanel({
    dir,
    root: ROOT,
    config: {
      // Nothing here buys a worker: the gateway is pinned at a dead port and every clock is an hour.
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: 3600,
    },
  });
  ok("the sandbox answers on its own port", Boolean(panel.port) && panel.port !== 7331, `port ${panel.port}`);
  console.log(`      base: ${panel.base}`);

  const verdict = await withBrowser(
    async ({ page }) => {
      await openPage(page, panel.base, { selector: "section.project, .job" });
      // The card is painted from the snapshot the panel serves. The seeded turn is the newest, so it is open.
      const found = await page
        .waitForSelector(`pre.job-out[data-out="${JOB_ID}"]`, { timeout: 25_000 })
        .then(() => true)
        .catch(() => false);
      if (!ok("the seeded turn's console is on the page", found)) return;
      const box = `pre.job-out[data-out="${JOB_ID}"]`;
      await page.waitForTimeout(400);

      // ---- (a) markdown is shapes, not punctuation -------------------------------------------------
      const a = await page.evaluate((sel) => {
        const out = document.querySelector(sel);
        // The prose is every console row that is NOT inside a fence: on this build that is the markdown blocks,
        // on a base build it is one escaped line per marker — which is exactly the difference the first check measures.
        const prose = [...out.querySelectorAll(".jl")]
          .filter((el) => !el.closest(".md-fence"))
          .map((el) => el.innerText)
          .join(String.fromCharCode(10));
        return {
          blocks: out.querySelectorAll(".md-block").length,
          strong: out.querySelectorAll(".md-block strong").length,
          em: out.querySelectorAll(".md-block em").length,
          code: out.querySelectorAll(".md-block code.md-code").length,
          codeChip: (() => {
            const el = out.querySelector(".md-block code.md-code");
            if (!el) return null;
            const cs = getComputedStyle(el);
            return { family: cs.fontFamily, bg: cs.backgroundColor, radius: cs.borderRadius };
          })(),
          list: out.querySelectorAll(".md-block.md-list .md-li").length,
          head: out.querySelectorAll(".md-block.md-head").length,
          prose,
          literalStrong: /^\*\*|\*\*$/m.test(prose),
          ltext: (out.querySelector(".md-block .md-l") || {}).dataset?.ltext ?? "",
        };
      }, box);
      ok("the prose is a markdown block, not one escaped line per marker", a.blocks > 0, `${a.blocks} blocks`);
      ok("no literal ** survives in what the reader reads", !/\*\*/.test(a.prose), JSON.stringify(a.prose.slice(0, 80)));
      ok("no literal backtick survives outside the fence", !/`/.test(a.prose));
      ok("**PR #279 MERGED** is a <strong>", a.strong >= 1, `${a.strong} strong`);
      ok("***finally*** is strong+em", a.em >= 1, `${a.em} em`);
      ok("`origin/main` is a <code> chip", a.code >= 1, `${a.code} code`);
      ok("the code chip is monospace and tinted", Boolean(a.codeChip) && /mono|consolas|cascadia/i.test(a.codeChip.family) && a.codeChip.bg !== "rgba(0, 0, 0, 0)", JSON.stringify(a.codeChip));
      ok("the bullet list is its own block", a.list >= 2, `${a.list} items`);
      ok("the heading is a heading", a.head >= 1);
      ok("data-ltext carries the SOURCE line, so a rebuild reads what was said", a.ltext.includes("**PR #279 MERGED**"), a.ltext);

      // ---- (b) the fence: a labelled well that counts and folds -------------------------------------
      const b = await page.evaluate((sel) => {
        const out = document.querySelector(sel);
        const well = out.querySelector(".md-fence");
        if (!well) return null;
        const body = well.querySelector(".md-fence-body");
        return {
          lang: well.dataset.mdLang,
          lines: well.dataset.mdLines,
          head: (well.querySelector(".md-fence-head") || {}).innerText || "",
          folded: well.classList.contains("is-folded"),
          hidden: body ? body.hidden : null,
          rows: body ? body.querySelectorAll(".md-l").length : 0,
          button: Boolean(well.querySelector("[data-md-fence]")),
          border: getComputedStyle(well).borderTopWidth,
        };
      }, box);
      ok("the fence is a bordered well with a language label", Boolean(b) && b.lang === "sh" && b.border !== "0px", JSON.stringify(b && { lang: b.lang, border: b.border }));
      ok("the well counts its lines", Boolean(b) && /20 lines/.test(b.head), b && b.head.replace(/\s+/g, " "));
      ok("past fifteen lines it arrives folded, with the button that opens it", Boolean(b) && b.folded === true && b.hidden === true && b.button === true);
      ok("every seeded line is in the well", Boolean(b) && b.rows === 20, b && `${b.rows} rows`);
      const fenceBtn = Boolean(b && b.button);
      const clicked = fenceBtn
        ? await page.click(`${box} .md-fence [data-md-fence]`, { timeout: 5000 }).then(() => true).catch(() => false)
        : false;
      if (!clicked) {
        ok("the fold opens on a real click: the body shows and aria-expanded says so", false, "there is no fence button to press");
        return;
      }
      await page.waitForTimeout(120);
      const open = await page.evaluate((sel) => {
        const well = document.querySelector(`${sel} .md-fence`);
        const body = well.querySelector(".md-fence-body");
        return {
          hidden: body.hidden,
          expanded: well.querySelector("[data-md-fence]").getAttribute("aria-expanded"),
          visible: body.getBoundingClientRect().height > 4,
        };
      }, box);
      ok("the fold opens on a real click: the body shows and aria-expanded says so", open.hidden === false && open.expanded === "true" && open.visible, JSON.stringify(open));

      // ---- (c) the raw toggle: the turn's own bytes, exactly ----------------------------------------
      const rawPresent = await page.$(`${box} ~ .out-tools [data-md-raw], .out-wrap [data-md-raw]`);
      ok("the console carries a raw control", Boolean(rawPresent));
      if (rawPresent) {
        // The strip is hover-revealed (and pinned only while a view is on), so the pointer goes to the console first:
        // the same gesture a reader makes, and it proves the reveal itself works.
        await page.hover(box);
        await page.click(".out-wrap [data-md-raw]");
        await page.waitForTimeout(150);
        const raw = await page.evaluate((sel) => {
          const out = document.querySelector(sel);
          return {
            on: out.dataset.rawView === "1",
            text: out.textContent,
            pressed: document.querySelector(".out-wrap [data-md-raw]").getAttribute("aria-pressed"),
            blocks: out.querySelectorAll(".md-block").length,
            strong: out.querySelectorAll("strong").length,
          };
        }, box);
        ok("the raw toggle says it is on", raw.on === true && raw.pressed === "true", JSON.stringify({ on: raw.on, pressed: raw.pressed }));
        ok("the raw view is the seeded text, byte for byte", raw.text === SEED_TEXT, raw.text === SEED_TEXT ? `${raw.text.length} chars, exact` : `got ${raw.text.length} chars / want ${SEED_TEXT.length}`);
        if (raw.text !== SEED_TEXT) {
          let i = 0;
          while (i < raw.text.length && i < SEED_TEXT.length && raw.text[i] === SEED_TEXT[i]) i++;
          said("first difference at", `${i} ${JSON.stringify(raw.text.slice(Math.max(0, i - 20), i + 20))} != ${JSON.stringify(SEED_TEXT.slice(Math.max(0, i - 20), i + 20))}`);
        }
        ok("nothing of the rendered shapes is left in the raw view", raw.blocks === 0 && raw.strong === 0, JSON.stringify({ blocks: raw.blocks, strong: raw.strong }));
        // ...and back again: the reader who came to read the rendered turn gets it back.
        await page.click(".out-wrap [data-md-raw]");
        await page.waitForTimeout(150);
        const back = await page.evaluate((sel) => {
          const out = document.querySelector(sel);
          return {
            on: out.dataset.rawView === "1",
            blocks: out.querySelectorAll(".md-block").length,
            strong: out.querySelectorAll(".md-block strong").length,
            pressed: document.querySelector(".out-wrap [data-md-raw]").getAttribute("aria-pressed"),
          };
        }, box);
        ok("toggling back restores the rendered view", back.on === false && back.blocks > 0 && back.strong >= 1 && back.pressed === "false", JSON.stringify(back));
      }

      // ---- (d) focus: the tool rows go, the prose and the error stay -------------------------------
      const focusPresent = await page.$(".out-wrap [data-md-focus]");
      ok("the console carries a focus control", Boolean(focusPresent));
      if (focusPresent) {
        const before = await page.evaluate((sel) => {
          const out = document.querySelector(sel);
          const tool = out.querySelector(".tgrp, .jl-tool");
          return { tool: Boolean(tool) && getComputedStyle(tool).display !== "none" };
        }, box);
        ok("the tool rows are on screen before focus", before.tool === true);
        await page.hover(box);
        await page.click(".out-wrap [data-md-focus]");
        await page.waitForTimeout(150);
        const f = await page.evaluate((sel) => {
          const out = document.querySelector(sel);
          const tool = out.querySelector(".tgrp, .jl-tool");
          const err = [...out.querySelectorAll(".jl-raw")].find((el) => /^error:/.test(el.dataset.ltext || ""));
          const text = out.querySelector(".md-block.md-para");
          const blocks = [...out.querySelectorAll(".md-block")];
          const last = blocks[blocks.length - 1];
          const shown = (el) => Boolean(el) && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
          return {
            toolVisible: shown(tool),
            toolDisplay: tool ? getComputedStyle(tool).display : null,
            errShown: shown(err),
            errText: err ? err.dataset.ltext : "",
            proseShown: shown(text),
            finalShown: shown(last),
            finalText: last ? last.innerText.slice(0, 60) : "",
            pressed: document.querySelector(".out-wrap [data-md-focus]").getAttribute("aria-pressed"),
          };
        }, box);
        ok("focus hides the tool rows", f.toolVisible === false, `display ${f.toolDisplay}`);
        ok("focus keeps the prose", f.proseShown === true);
        ok("focus keeps the error line", f.errShown === true, f.errText);
        ok("focus keeps the final message", f.finalShown === true, f.finalText);
        ok("focus says it is on", f.pressed === "true");
      }
      // ---- (a2) the LIVE append: a streamed line grows the block, it does not repaint the console -------
      // The seeded turn above is a repaint (turnBody). A live turn arrives one line at a time through
      // appendJobLine -> drawJobLine, and that path has to produce the same shapes: this feeds the shipped
      // entry point the exact frames an SSE `jobline` carries and reads the console back.
      const beforeFirst = await page.evaluate((sel) => document.querySelector(sel).firstElementChild.outerHTML, box);
      await page.evaluate(({ id }) => {
        const feed = (text, lid) => appendJobLine({ id, line: { kind: "text", text, lid, at: Date.now() } });
        feed("appended **live** with `code`", 9001);
        feed("```js", 9002);
        feed("const live = true;", 9003);
        feed("```", 9004);
      }, { id: JOB_ID });
      // The word pacer types a fresh line in, row by row, through drawRowText — the append path has to survive that
      // too, so the reading happens after it has finished rather than on the frame the line landed.
      await page.waitForTimeout(1500);
      const live = await page.evaluate(({ boxSel }) => {
        const out = document.querySelector(boxSel);
        const blocks = [...out.querySelectorAll(".md-block")];
        const fences = blocks.filter((b) => b.dataset.mdBlock === "fence");
        const fence = fences[fences.length - 1];
        const para = blocks.filter((b) => b.dataset.mdBlock === "para").pop();
        return {
          blocks: blocks.length,
          strong: out.querySelectorAll(".md-block strong").length,
          code: out.querySelectorAll(".md-block code.md-code").length,
          liveText: para ? para.innerText : "",
          fence: fence ? { lang: fence.dataset.mdLang, lines: fence.dataset.mdLines, head: (fence.querySelector(".md-fence-head") || {}).innerText, folded: fence.classList.contains("is-folded"), body: (fence.querySelector(".md-fence-body") || {}).innerText } : null,
        };
      }, { boxSel: box });
      ok("a streamed prose line is appended as a markdown block", live.blocks >= 7, `${live.blocks} blocks`);
      ok("a streamed line's **markers** are shapes too", /appended live with code/.test(live.liveText) && live.strong >= 2 && live.code >= 2, JSON.stringify(live.liveText));
      ok("a fence opened live is a labelled well with its count", Boolean(live.fence) && live.fence.lang === "js" && live.fence.lines === "1" && /js/.test(live.fence.head) && /1 line/.test(live.fence.head), JSON.stringify(live.fence));
      const afterFirst = await page.evaluate((sel) => document.querySelector(sel).firstElementChild.outerHTML, box);
      ok("the append did not repaint the blocks above it", beforeFirst === afterFirst);

    },
    { viewport: VIEWPORT },
  );
  browserResult = verdict;
}

try {
  await main();
} catch (e) {
  // No Playwright is the house's own sentence, and it is a FAILURE, never a silent pass.
  const why = String((e && e.message) || e);
  if (/playwright/i.test(why)) {
    ok("the browser half ran", false, "BROWSER-HALF-NOT-RUN — no Playwright install found (set PANEL_PLAYWRIGHT_ROOT)");
  } else {
    ok("the gate ran to the end", false, why.split("\n")[0]);
    if (panel) console.log(`      panel log tail:\n${panel.log().split("\n").slice(-12).join("\n")}`);
  }
} finally {
  if (panel) await panel.stop();
}

console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks${browserResult === null ? "" : ""}`);
process.exit(failures ? 1 : 0);
