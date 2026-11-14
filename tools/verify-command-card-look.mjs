// The assistant console command card's look, driven in a real browser on a throwaway panel.
// HARNESS: LIVE GATE - a seeded fixture, so it runs anywhere Playwright is installed.
//
//   node tools/verify-command-card-look.mjs                        # this checkout
//   node tools/verify-command-card-look.mjs --shots <dir>          # where the captures go
//   node tools/verify-command-card-look.mjs --json <file>          # keep the raw ledger
//   node tools/verify-command-card-look.mjs --html <file>          # a page of the shots and their numbers
//
// THE CHANGE. A command card folds its BODY to a few preview rows instead of shutting, and read as it was, a prompt
// cut mid sentence ended cleanly at the clamp's edge: a reader could not tell a finished prompt from a truncated one,
// and nothing in the card named the text under its head. So (1) the last visible preview row of a FOLDED card now
// ends with three ASCII dots and an open one draws none, (2) a bold `Prompt:` label starts the body's first row,
// inline, and (3) five numbers that were fixed in the stylesheet are Settings > Display rows: the preview rows, the
// card's side margin, the padding of the text inside it, the blank lines above and below it, and the side margin the
// rest of the console's text keeps. Every default is today's look, exactly.
//
// WHAT IS DRIVEN (nothing synthetic reaches the page): a throwaway panel of its own (tools/panel-testkit.mjs - spare
// port, own PANEL_CONFIG / HERMES_HOME / jobs.json, API_SERVER_KEY empty), no gateway, the assistant's own rules off,
// and ONE thread whose newest turn is drawn OPEN, so its console body is the transcript a reader reads a reply in:
//
//   the console's own words, before the card.
//   QUEUE assistant-3 | [Fold marker] <a prompt long enough to wrap well past eight preview rows>
//   QUEUE assistant-3 | corner resize                                    (one row: nothing is hidden, so no dots)
//   the console's own words after the cards.
//
// WHAT IT ASSERTS, off the painted console:
//   (1) DEFAULT IS TODAY'S LOOK: the card is folded to two rows of 18px (36px, the 3em the rule used to say), its
//       body's side padding is 8px, its side margin is 0, its margin above is the 4px frame margin, and the console's
//       own text keeps its 18px tab - the card and the prose beside it line up, as they did before the settings;
//   (2) THREE DOTS END THE LAST VISIBLE ROW: the folded card's body ends with exactly `...`, in a `.code-fold-dots`
//       span whose box is inside the body's clamp (bottom at or above the fold's edge, right inside the padding), so
//       the marker is VISIBLE and not clipped with the text it replaced;
//   (3) NOTHING IS LOST: the text before the dots is an exact prefix of the whole prompt, and opening the card puts
//       the whole prompt back byte for byte with no dots at all - then folding it marks it again;
//   (4) A CARD WHOSE PROMPT FITS IS NOT MARKED: the one-row card draws no dots and no label-only body;
//   (5) THE LABEL: `Prompt:` is the body's first child, bold (700), inline on the first row (not a row of its own);
//   (6) EACH OF THE FIVE ROWS MOVES WHAT IT NAMES, at its minimum and its maximum, measured on the painted page AND
//       read off the store: 1 and 8 preview rows (18px and 144px, dots at both), 0 and 60px side margin, 0 and 32px
//       padding (the head and the bullets follow it), 0 and 4 blank lines (the gap above the card grows by 72px), and
//       0 and 60px for the console's text (the prose and the card move together, the card staying in the column);
//   (7) the preview-row setting and the fold are ONE number: the card's `data-code-clamp` and the drawn height agree
//       at every value, and the setting is saved in this browser (`wtgui.cmdLook`);
//   (8) the five rows are on the Display tab of Settings, each a number box with its own floor and ceiling, and one
//       press of `use defaults` puts all five back to today's look;
//   (9) nothing pressed here raised a page error.
//
// Exit codes: 0 held; 1 a check failed; 2 the run did not measure what it claims (no Playwright, no card, no store).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun, openSettingsGroup, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-command-card-look")));
const JSON_OUT = opt("--json");
const HTML_OUT = opt("--html");
const THREAD = "panel-assistant";

// The prompt: long on purpose. The reader's rows can go to 8 (144px), so the fixture's prompt has to overflow EIGHT
// rows at this console's width or the top of the setting would be measured on a card that is not folded at all.
const SENTENCE = "corner resize the board's tail and the transcript together, ";
const LONG = SENTENCE.repeat(30).trim();
// One row, at any fold: the card is drawn, the whole prompt is on the page, and there is nothing to mark.
const SHORT = "corner resize";
const TRANSCRIPT = [
  "the console's own words, before the card.",
  `QUEUE assistant-3 | [Fold marker] ${LONG}`,
  `QUEUE assistant-3 | ${SHORT}`,
  "the console's own words after the cards.",
];
// Today's look, as numbers, in one place: the defaults the checks compare against. `NOW_STORE` is the same five as
// the store holds them, in the order the app writes them (the object it saves is CMD_LOOK_DEFAULTS' own key order).
const NOW = { rows: 2, side: 0, pad: 8, blank: 0, con: 10, rowPx: 18 };
const NOW_STORE = { rows: 2, side: 0, pad: 8, blank: 0, con: 10 };

let checks = 0;
let failures = 0;
const out = { tree: TREE, shots: SHOTS, steps: [], notMeasured: [], errors: [] };
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);

// ---- the fixture: one thread, one open turn, four console lines ------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-command-card-look-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
const now = Date.now();
// Filed under a tree derived from the checkout being served, never a path from the machine this was written on.
const seedPath = path.join(TREE, ".worktrees", "command-card-look-fixture-0001").replace(/\\/g, "/");
const job = {
  id: "cmdlook1",
  thread: THREAD,
  turn: 1,
  prompt: "draw the command card's look",
  status: "done",
  exitCode: 0,
  startedAt: new Date(now - 60_000).toISOString(),
  endedAt: new Date(now - 30_000).toISOString(),
  durationMs: 30_000,
  finalMessage: TRANSCRIPT.join("\n"),
  cwd: seedPath,
  ownerPath: seedPath,
  worktreePath: seedPath,
  worktree: "command-card-look-fixture-0001",
  // ONE console line carrying the whole message, newlines and all - the shape lib/jobs.js pushes for a final
  // message, so the console draws it through the physical-line expansion it always does.
  lines: [{ kind: "text", text: TRANSCRIPT.join("\n"), lid: 1, at: now - 31_000 }],
};
const jobsFile = path.join(dir, "logs", "jobs.json");
writeFileSync(jobsFile, JSON.stringify({ savedAt: new Date(now).toISOString(), jobs: [job] }, null, 1));

const { freePort, startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  root: TREE,
  config: {
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    discoverSeconds: 3600,
    assistant: { enabled: false },
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
  },
});

// ---- what the painted console says ---------------------------------------------------------------------------
// Read in the page, over the newest turn's own console body: the two cards, the fold, the marker's box against the
// clamp's edge, the label, and the four measurements a setting moves.
function readConsole(thread) {
  const turns = [...document.querySelectorAll(`#assistant .job[data-thread="${thread}"] .turn`)];
  const turn = turns[turns.length - 1];
  const pre = turn ? turn.querySelector("pre.job-out") : null;
  if (!pre) return null;
  const cards = [...pre.querySelectorAll(".code-box.is-cmd")];
  const byText = (needle) => cards.find((c) => String(c.getAttribute("data-ltext") || "").includes(needle)) || null;
  const box = byText("[Fold marker]");
  const fits = byText("| corner resize");
  if (!box) return null;
  const head = box.querySelector(".code-head");
  const body = box.querySelector(".code-body");
  const dots = body ? body.querySelector(".code-fold-dots") : null;
  const label = body ? body.querySelector(".code-prompt-label") : null;
  const preBox = pre.getBoundingClientRect();
  const turnBox = turn.getBoundingClientRect();
  const card = box.getBoundingClientRect();
  const bodyBox = body.getBoundingClientRect();
  const dotsBox = dots ? dots.getBoundingClientRect() : null;
  const labelBox = label ? label.getBoundingClientRect() : null;
  const cs = getComputedStyle(body);
  const cardCs = getComputedStyle(box);
  const headCs = getComputedStyle(head);
  const preCs = getComputedStyle(pre);
  const root = getComputedStyle(document.documentElement);
  const prose = [...pre.querySelectorAll(".md-para .jl")].map((row) => {
    const r = row.getBoundingClientRect();
    return { text: String(row.textContent || "").trim(), left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom) };
  });
  const firstRow = body ? body.querySelector(".jl") : null;
  const firstRowBox = firstRow ? firstRow.getBoundingClientRect() : null;
  const bullets = box.querySelector(".code-bullets");
  const textOf = (el) => (el ? String(el.textContent || "") : "");
  const cut = textOf(body).replace(/\s*\.\.\.\s*$/, "").replace(/^Prompt:\s?/, "");
  // The payload the body holds: the line after the recipient, with a leading `[Title]` taken off the way the card
  // takes it off (the title is the head's, not the prompt's).
  const whole = String(box.getAttribute("data-ltext") || "").split("|").slice(1).join("|").trim().replace(/^\[[^\]]*\]\s*/, "");
  let store = null;
  try {
    store = JSON.parse(localStorage.getItem("wtgui.cmdLook") || "null");
  } catch {
    store = null;
  }
  const fitsBox = fits ? fits.getBoundingClientRect() : null;
  return {
    found: true,
    // the card's own state
    ltext: box.getAttribute("data-ltext"),
    clamp: box.getAttribute("data-code-clamp"),
    clamped: box.classList.contains("is-clamped"),
    open: box.classList.contains("is-open"),
    aria: head ? head.getAttribute("aria-expanded") : null,
    hint: head && head.querySelector(".code-hint") ? String(head.querySelector(".code-hint").textContent || "").trim() : "",
    // the fold, in pixels
    rows: root.getPropertyValue("--cmd-rows").trim(),
    bodyH: Math.round(bodyBox.height),
    bodyScroll: Math.round(body.scrollHeight),
    bodyTop: Math.round(bodyBox.top),
    bodyBottom: Math.round(bodyBox.bottom),
    lineH: Math.round(parseFloat(cs.lineHeight) || 0),
    padLeft: Math.round(parseFloat(cs.paddingLeft) || 0),
    padRight: Math.round(parseFloat(cs.paddingRight) || 0),
    bodyLeft: Math.round(bodyBox.left),
    bodyRight: Math.round(bodyBox.right),
    // the marker
    dots: dots ? String(dots.textContent || "") : null,
    dotsCount: body ? body.querySelectorAll(".code-fold-dots").length : 0,
    dotsLast: body ? body.lastElementChild === dots || (dots && body.lastElementChild && body.lastElementChild.contains(dots)) : false,
    dotsBox: dotsBox ? { top: Math.round(dotsBox.top), bottom: Math.round(dotsBox.bottom), right: Math.round(dotsBox.right) } : null,
    dotsVisible: dotsBox ? dotsBox.bottom <= bodyBox.top + bodyBox.height + 1 && dotsBox.top >= bodyBox.top - 1 : null,
    dotsInside: dotsBox ? dotsBox.right <= bodyBox.left + bodyBox.width - (parseFloat(cs.paddingRight) || 0) + 1 : null,
    // the text: what a folded card leaves, and what an open one holds
    text: textOf(body),
    cut,
    whole,
    cutIsPrefix: cut.length > 0 && whole.startsWith(cut),
    cutShorter: cut.length < whole.length,
    // the label
    label: label ? String(label.textContent || "") : null,
    labelWeight: label ? getComputedStyle(label).fontWeight : null,
    labelFirst: body ? body.firstElementChild === firstRow && firstRow.firstElementChild === label : false,
    // the label is on the first row, not a row above it: its box sits inside the first row's own box
    labelInline: labelBox && firstRowBox ? labelBox.top >= firstRowBox.top - 1 && labelBox.bottom <= firstRowBox.bottom + 1 && labelBox.left >= firstRowBox.left - 1 : null,
    // the five numbers, as the page drew them
    vars: {
      rows: root.getPropertyValue("--cmd-rows").trim(),
      side: root.getPropertyValue("--cmd-side").trim(),
      pad: root.getPropertyValue("--cmd-pad").trim(),
      blank: root.getPropertyValue("--cmd-blank").trim(),
      con: root.getPropertyValue("--con-side").trim(),
    },
    store,
    // the card's place: inside the console's own text column
    card: { left: Math.round(card.left), top: Math.round(card.top), bottom: Math.round(card.bottom), width: Math.round(card.width) },
    cardMarginTop: Math.round(parseFloat(cardCs.marginTop) || 0),
    cardMarginLeft: Math.round(parseFloat(cardCs.marginLeft) || 0),
    cardMarginRight: Math.round(parseFloat(cardCs.marginRight) || 0),
    // The console body's own inset: the number "console text side margin" moves, and the column the card is measured
    // from. Its 1px border is what makes the text start one pixel further in than the box.
    prePadLeft: Math.round(parseFloat(preCs.paddingLeft) || 0),
    prePadRight: Math.round(parseFloat(preCs.paddingRight) || 0),
    preBorder: Math.round(parseFloat(preCs.borderLeftWidth) || 0),
    pre: { left: Math.round(preBox.left), width: Math.round(preBox.width) },
    turn: { left: Math.round(turnBox.left), width: Math.round(turnBox.width) },
    headPadLeft: Math.round(parseFloat(headCs.paddingLeft) || 0),
    bulletsPadLeft: bullets ? Math.round(parseFloat(getComputedStyle(bullets).paddingLeft) || 0) : null,
    prose,
    // the one-row card, for "a prompt that fits is not marked"
    fits: fitsBox
      ? {
          found: true,
          dots: fits.querySelectorAll(".code-fold-dots").length,
          bodyH: Math.round((fits.querySelector(".code-body") || fits).getBoundingClientRect().height),
          clamp: fits.getAttribute("data-code-clamp"),
        }
      : { found: false },
  };
}

// Drive one settings row the way the row's own handler expects: the value, then `change`. The row is the reader's
// control, so the same listener runs as a press-and-blur would run.
const setRow = (page, id, value) =>
  page.evaluate(
    ({ id, value }) => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.value = String(value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return document.getElementById(id).value === String(value);
    },
    { id, value },
  );

// ---- the pids and paths this run owns, so they can be quoted and reaped ---------------------------------------
// Playwright does not expose a browser pid, so the browser is found the only honest way on this host: the Chromium
// processes that were not running before the launch. Its command line also names the profile directory Playwright
// made for it, which is the path to quote (and to check is gone after the close).
function processSnapshot() {
  if (process.platform !== "win32") return [];
  try {
    const raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|chromium' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
      { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const parsed = JSON.parse(String(raw).trim() || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: Number(p.ProcessId), name: String(p.Name || ""), cmd: String(p.CommandLine || "") }));
  } catch {
    return [];
  }
}
const alivePid = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log(notRun("the console command card's look", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)"));
  process.exit(2);
}

const browserPids = [];
let profileDir = null;
const beforeLaunch = processSnapshot();
try {
  console.log(`console command card look gate on ${TREE}`);
  console.log(`  sandbox: ${panel.base} - one seeded turn, four console lines, no gateway - shots ${SHOTS}`);
  mkdirSync(SHOTS, { recursive: true });
  const screens = [];

  await withBrowser(
    async ({ browser, page, pageErrors }) => {
      // The Chromium this launch started: its own pid, and the profile directory its command line names.
      const mine = processSnapshot().filter((p) => !beforeLaunch.some((b) => b.pid === p.pid));
      for (const p of mine) browserPids.push(p.pid);
      const withProfile = mine.find((p) => /--user-data-dir=/.test(p.cmd));
      if (withProfile) profileDir = (withProfile.cmd.match(/--user-data-dir=("[^"]+"|\S+)/) || [])[1].replace(/^"|"$/g, "");
      out.browser = { pids: mine.map((p) => p.pid), profile: profileDir };
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.addInitScript(() => {
        try {
          localStorage.setItem("wm.assistantOpen", "1");
        } catch {
          /* a browser with storage off still draws the rail on its default */
        }
      });
      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`#assistant .job[data-thread="${THREAD}"] .turn .code-box.is-cmd`, { timeout: 45_000 });
      await page.waitForTimeout(900);

      const read = () => page.evaluate(readConsole, THREAD);
      const shot = async (name) => {
        const state = await read();
        if (!state) return null;
        // The console around the card, so a reader sees the card's place: a band of console text above and below it,
        // from the console's left edge to its right, tall enough for the largest blank line the setting can add.
        const top = Math.max(0, state.card.top - 190);
        const height = Math.min(760, state.card.bottom + 150 - top);
        const clip = { x: Math.max(0, state.turn.left - 26), y: top, width: Math.min(1440 - Math.max(0, state.turn.left - 26), state.turn.width + 52), height };
        const file = path.join(SHOTS, `${name}.png`);
        await page.screenshot({ path: file, clip });
        note(`screenshot ${file}`);
        screens.push({ name, file, state });
        return file;
      };

      // ---- (1) THE DEFAULT IS TODAY'S LOOK -------------------------------------------------------------------
      let s = await read();
      out.steps.push({ step: "default", ...s });
      check(Boolean(s), "the console draws the command card from the seeded turn");
      if (!s) return;
      check(s.clamped === true && s.clamp === "2", "folded at the default, and the card says so", `clamp=${s.clamp}`);
      check(s.bodyH === NOW.rows * NOW.rowPx, "two preview rows are 36px - the 3em the rule used to spell out", `${s.bodyH}px`);
      check(s.padLeft === NOW.pad && s.padRight === NOW.pad, "the body's side padding is the 8px it always was", `${s.padLeft}/${s.padRight}`);
      check(s.cardMarginLeft === NOW.side && s.cardMarginRight === NOW.side, "the card's side margin is 0, as before", `${s.cardMarginLeft}`);
      check(s.cardMarginTop === 4, "the card keeps its 4px frame margin above, with no blank line added", `${s.cardMarginTop}px`);
      check(s.headPadLeft === NOW.pad, "the head's text starts at the body's padding, so the two line up", `${s.headPadLeft}px`);
      // The right inset is the copy button's 24px room on a block that has one, and the setting only raises it past
      // that: the left side, which the card's own margin is measured from, is the setting's own number.
      check(s.prePadLeft === NOW.con && s.prePadRight === 24, "the console's own text keeps its 10px inset, and the copy button its 24px", `${s.prePadLeft}/${s.prePadRight}`);
      const proseLeft = s.prose.length ? s.prose[0].left : null;
      check(proseLeft !== null && proseLeft - (s.pre.left + s.preBorder + s.prePadLeft) === 0, "a line of console prose starts at that inset", `${proseLeft} = ${s.pre.left}+${s.preBorder}+${s.prePadLeft}`);
      check(s.card.left === proseLeft, "and the card starts on the same pixel: the default adds no margin of its own", `card ${s.card.left} vs prose ${proseLeft}`);
      check(s.vars.rows === "2" && s.vars.side === "0px" && s.vars.pad === "8px" && s.vars.blank === "0" && s.vars.con === "10px", "the five variables carry today's numbers, units and all", JSON.stringify(s.vars));

      // ---- (2) THREE DOTS END THE LAST VISIBLE ROW -----------------------------------------------------------
      check(s.dots === "...", "the folded card's last preview row ends with three ASCII dots", JSON.stringify(s.dots));
      check(s.dotsCount === 1, "one marker per card, not one per row", `${s.dotsCount}`);
      check(s.dotsLast === true, "and it is the last thing in the body: nothing of the prompt follows it");
      check(s.dotsVisible === true, "the marker's own box is inside the clamp, so it is drawn and not cut with the text", JSON.stringify(s.dotsBox));
      check(s.dotsInside === true, "and it fits inside the body's padding on the right", JSON.stringify(s.dotsBox));
      check(s.cutIsPrefix === true, "the text before the dots is an exact prefix of the prompt: cut, never rewritten", `${s.cut.length}/${s.whole.length} chars`);
      check(s.cutShorter === true, "and it is shorter: the card really is showing less than the whole prompt");
      check(s.label === "Prompt:" && s.labelFirst === true, "the bold Prompt: label is the body's first child", JSON.stringify(s.label));
      check(s.labelWeight === "700", "and it is bold", `${s.labelWeight}`);
      check(s.labelInline === true, "inline on the first row, not on a row of its own", JSON.stringify(s.labelInline));
      check(s.fits && s.fits.found && s.fits.dots === 0, "a card whose prompt fits its rows draws no dots", JSON.stringify(s.fits));
      await shot("00-default-two-rows");

      // ---- (3) OPENING PUTS THE WHOLE PROMPT BACK, FOLDING MARKS IT AGAIN ------------------------------------
      const head = page.locator(`#assistant .job[data-thread="${THREAD}"] .turn .code-box.is-cmd`).filter({ has: page.locator(".code-what", { hasText: "Fold marker" }) }).locator(".code-head").first();
      await head.click();
      await page.waitForTimeout(220);
      let open = await read();
      out.steps.push({ step: "open", ...open });
      check(open.dotsCount === 0, "an open card draws no marker at all", `${open.dotsCount}`);
      check(open.open === true && open.aria === "true" && open.clamped === false, "the press opened it", JSON.stringify([open.open, open.aria, open.clamped]));
      check(open.text.replace(/^Prompt:\s?/, "").trim() === open.whole, "and the whole prompt is on the page, byte for byte", `${open.text.length} chars`);
      check(open.bodyH > NOW.rows * NOW.rowPx, "the open card is taller than its fold: there really was more to read", `${open.bodyH}px > ${NOW.rows * NOW.rowPx}px`);
      check(open.hint === "click to fold", "the hint says what the next press does", JSON.stringify(open.hint));
      await shot("01-default-open");
      await head.click();
      await page.waitForTimeout(260);
      s = await read();
      check(s.clamped === true && s.dotsCount === 1 && s.dots === "...", "folding it back marks it again", JSON.stringify([s.clamped, s.dots]));

      // ---- (4) THE FIVE ROWS ON THE DISPLAY TAB --------------------------------------------------------------
      await openSettingsGroup(page, "display");
      const rows = await page.evaluate(() => {
        const ids = ["cmd-rows", "cmd-side", "cmd-pad", "cmd-blank", "cmd-con"];
        return {
          present: ids.map((id) => {
            const el = document.getElementById(id);
            if (!el) return { id, found: false };
            const box = el.getBoundingClientRect();
            return { id, found: true, type: el.type, min: el.min, max: el.max, value: el.value, visible: box.width > 0 && box.height > 0 };
          }),
          reset: Boolean(document.getElementById("cmd-look-reset")),
          tab: (() => {
            const t = document.querySelector('[data-settings-tab="display"]');
            return t ? t.getAttribute("aria-selected") : null;
          })(),
        };
      });
      out.steps.push({ step: "settings-rows", ...rows });
      check(rows.tab === "true", "the Display tab is the one on screen");
      check(rows.present.every((r) => r.found && r.type === "number" && r.visible), "all five rows are on the Display tab, as number boxes", JSON.stringify(rows.present.map((r) => r.id)));
      check(rows.present[0].min === "1" && rows.present[0].value === "2", "preview rows: a floor of 1, defaulting to 2", JSON.stringify([rows.present[0].min, rows.present[0].value]));
      check(rows.reset === true, "and one press puts all five back");
      // The five floors and ceilings the settings store clamps to, read from the markup the reader types into.
      const limits = Object.fromEntries(rows.present.map((r) => [r.id, `${r.min}..${r.max}`]));
      check(
        JSON.stringify(limits) === JSON.stringify({ "cmd-rows": "1..8", "cmd-side": "0..60", "cmd-pad": "0..32", "cmd-blank": "0..4", "cmd-con": "0..60" }),
        "every row carries its own floor and ceiling, the same numbers app.js clamps to",
        JSON.stringify(limits),
      );
      // The rows as the reader sees them: the group's own heading, the five boxes and the one press that resets them.
      const panelBox = await page.evaluate(() => {
        const first = document.getElementById("cmd-rows").closest(".settings-row");
        // The group's own heading sits above the first row: two rows up in the panel's markup.
        const intro = first.previousElementSibling && first.previousElementSibling.previousElementSibling;
        (intro || first).scrollIntoView({ block: "center" });
        // Down to the reset press that belongs to the group, which is the row after the last input.
        const resetRow = document.getElementById("cmd-look-reset");
        const last = (resetRow && resetRow.closest(".settings-row") ? resetRow.closest(".settings-row") : document.getElementById("cmd-con").closest(".settings-row")).getBoundingClientRect();
        const head = (intro && intro.getBoundingClientRect().top) || first.getBoundingClientRect().top;
        const from = Math.max(0, head - 10);
        return { from, x: Math.max(0, last.left - 24), width: Math.max(320, Math.min(window.innerWidth - last.left + 24, last.width + 48)), height: Math.min(window.innerHeight - from, last.bottom + 12 - from) };
      });
      await page.waitForTimeout(200);
      const panelShot = path.join(SHOTS, "05-settings-rows.png");
      await page.screenshot({ path: panelShot, clip: { x: panelBox.x, y: panelBox.from, width: panelBox.width, height: Math.max(120, panelBox.height) } });
      note(`screenshot ${panelShot}`);
      screens.push({ name: "05-settings-rows", file: panelShot, state: await read() });
      // A second capture, scrolled to the group's foot: the press that puts all five back, which sits below the
      // viewport when the group's heading is in it.
      const resetBox = await page.evaluate(() => {
        const btn = document.getElementById("cmd-look-reset");
        btn.scrollIntoView({ block: "center" });
        const row = btn.closest(".settings-row") || btn;
        const box = row.getBoundingClientRect();
        const con = document.getElementById("cmd-con").closest(".settings-row").getBoundingClientRect();
        const from = Math.max(0, con.top - 6);
        return { x: Math.max(0, box.left - 24), width: Math.max(320, Math.min(window.innerWidth - box.left + 24, box.width + 48)), from, height: Math.max(60, Math.min(window.innerHeight - from, box.bottom + 12 - from)) };
      });
      await page.waitForTimeout(200);
      const resetShot = path.join(SHOTS, "06-settings-reset.png");
      await page.screenshot({ path: resetShot, clip: { x: resetBox.x, y: resetBox.from, width: resetBox.width, height: resetBox.height } });
      note(`screenshot ${resetShot}`);
      screens.push({ name: "06-settings-reset", file: resetShot, state: await read() });
      // The reader's own path on one row: type into the box, leave it, and the card is already drawn at the new fold.
      await page.fill("#cmd-rows", "3");
      await page.keyboard.press("Tab");
      await page.waitForTimeout(220);
      await page.click("#btn-settings");
      await page.waitForTimeout(200);
      s = await read();
      check(s.bodyH === 3 * NOW.rowPx && s.clamp === "3", "typing 3 into the box folds the card to three rows at once", `${s.bodyH}px clamp=${s.clamp}`);
      check(s.store && s.store.rows === 3, "and the number is saved in this browser", JSON.stringify(s.store));
      await page.click("#btn-settings");
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById("cmd-look-reset").click());
      await page.waitForTimeout(200);
      await page.click("#btn-settings");
      await page.waitForTimeout(200);
      const back = await read();
      check(JSON.stringify(back.store) === JSON.stringify(NOW_STORE), "and use defaults puts the five back", JSON.stringify(back.store));

      // ---- (5) EACH ROW, AT ITS MIN AND ITS MAX ----------------------------------------------------------------
      // One pass per setting: the minimum, then the maximum, then back to the default. Every state is measured and
      // captured, so the shots and the numbers come from the same frame.
      const states = {};
      const measure = async (name) => {
        const state = await read();
        states[name] = state;
        out.steps.push({ step: name, ...state });
        return state;
      };
      const apply = async (id, value, name) => {
        await setRow(page, id, value);
        await page.waitForTimeout(260);
        const state = await measure(name);
        await shot(name);
        return state;
      };
      const reset = async () => {
        await page.evaluate(() => document.getElementById("cmd-look-reset").click());
        await page.waitForTimeout(220);
      };

      // preview rows: 1 and 8
      let one = await apply("cmd-rows", 1, "10-rows-min-1");
      check(one.bodyH === 1 * NOW.rowPx && one.clamp === "1", "preview rows at 1: one 18px row on the page", `${one.bodyH}px`);
      check(one.dots === "..." && one.dotsVisible === true, "and the one row still ends with the marker, inside it", JSON.stringify(one.dotsBox));
      check(one.cutIsPrefix === true && one.cutShorter === true, "still a cut of the whole prompt, never a rewrite");
      await reset();
      let eight = await apply("cmd-rows", 8, "11-rows-max-8");
      check(eight.bodyH === 8 * NOW.rowPx && eight.clamp === "8", "preview rows at 8: eight 18px rows on the page", `${eight.bodyH}px`);
      check(eight.dots === "..." && eight.dotsVisible === true, "and the marker ends the eighth row", JSON.stringify(eight.dotsBox));
      check(eight.cutIsPrefix === true && eight.cutShorter === true && eight.cut.length > one.cut.length, "the fixture's prompt is longer than eight rows, so the maximum is measured on a folded card", `${one.cut.length} -> ${eight.cut.length} chars`);
      await reset();

      // the card's side margin: 0 and 60
      let side0 = await apply("cmd-side", 0, "20-side-min-0");
      check(side0.card.left === side0.prose[0].left, "side margin at 0: the card starts at the console's text column", `${side0.card.left} vs ${side0.prose[0].left}`);
      await reset();
      let side60 = await apply("cmd-side", 60, "21-side-max-60");
      check(side60.card.left - side60.prose[0].left === 60, "side margin at 60: the card moves 60px in from that column", `${side60.card.left - side60.prose[0].left}px`);
      check(side60.card.width === side0.card.width - 120, "and is 120px narrower: it gives up both sides, not one", `${side0.card.width - side60.card.width}px`);
      check(side60.card.left + side60.card.width <= side60.pre.left + side60.preBorder + side60.pre.width - side60.preBorder - side60.prePadRight + 1, "the card stays inside the console it belongs to");
      await reset();

      // the padding inside the box: 0 and 32
      let pad0 = await apply("cmd-pad", 0, "30-pad-min-0");
      check(pad0.padLeft === 0 && pad0.padRight === 0, "padding at 0: the body's text touches the card's own edge", `${pad0.padLeft}`);
      check(pad0.headPadLeft === 0, "and the head follows it", `${pad0.headPadLeft}`);
      await reset();
      let pad32 = await apply("cmd-pad", 32, "31-pad-max-32");
      check(pad32.padLeft === 32 && pad32.padRight === 32, "padding at 32: 32px of air on both sides of the text", `${pad32.padLeft}`);
      check(pad32.headPadLeft === 32, "the head follows that too, so the label and the prompt stay in one column", `${pad32.headPadLeft}`);
      check(pad32.dots === "..." && pad32.dotsVisible === true, "the narrower text column still ends its fold with a visible marker", JSON.stringify(pad32.dotsBox));
      await reset();

      // the blank lines above and below: 0 and 4
      let blank0 = await apply("cmd-blank", 0, "40-blank-min-0");
      check(blank0.cardMarginTop === 4, "blank lines at 0: the card's own 4px frame margin, as before", `${blank0.cardMarginTop}px`);
      await reset();
      let blank4 = await apply("cmd-blank", 4, "41-blank-max-4");
      check(blank4.cardMarginTop === 4 + 4 * NOW.rowPx, "blank lines at 4: 72px added above the frame margin", `${blank4.cardMarginTop}px`);
      const gapOf = (st) => {
        const above = st.prose.filter((p) => p.bottom <= st.card.top);
        return above.length ? st.card.top - Math.max(...above.map((p) => p.bottom)) : null;
      };
      const gapBefore = gapOf(blank0);
      const gapAfter = gapOf(blank4);
      check(gapBefore !== null && gapAfter === gapBefore + 4 * NOW.rowPx, "and the page shows it: the gap above the card grew by exactly 72px", `${gapBefore}px -> ${gapAfter}px`);
      await reset();

      // the console's text side margin: 0 and 60
      let con0 = await apply("cmd-con", 0, "50-con-min-0");
      check(con0.prePadLeft === 0 && con0.prePadRight === 24, "console text margin at 0: the left runs to the box's own edge, the copy button keeps its room", `${con0.prePadLeft}/${con0.prePadRight}`);
      check(con0.card.left === con0.prose[0].left, "the card follows it, keeping its own margin of 0", `card ${con0.card.left} vs prose ${con0.prose[0].left}`);
      await reset();
      let con60 = await apply("cmd-con", 60, "51-con-max-60");
      check(con60.prePadLeft === 60 && con60.prePadRight === 60, "console text margin at 60: the text's inset is 60px on both sides, past the copy button's room", `${con60.prePadLeft}/${con60.prePadRight}`);
      check(con60.prose[0].left === con0.prose[0].left + 60 && con60.card.left === con60.prose[0].left, "and the whole text column moved 60px in, the card with it", `${con0.prose[0].left} -> ${con60.prose[0].left}`);
      check(con60.dots === "..." && con60.dotsVisible === true, "the narrower column still ends its fold with the marker", JSON.stringify(con60.dotsBox));
      await reset();

      // ---- (6) BACK AT THE DEFAULT, AND NOTHING ERRORS --------------------------------------------------------
      const after = await read();
      check(after.bodyH === NOW.rows * NOW.rowPx && after.clamp === "2" && after.vars.con === "10px", "use defaults puts the drawn card back where it started", JSON.stringify([after.bodyH, after.clamp, after.vars.con]));
      const errors = [...pageErrors];
      out.errors = errors.map((e) => String(e && e.message ? e.message : e));
      check(errors.length === 0, "no press raised a page error", `${errors.length}`);
      out.states = states;
      out.screens = screens.map((sc) => ({ name: sc.name, file: sc.file }));
    },
    { viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 },
  );
} catch (err) {
  failures += 1;
  out.errors.push(String(err && err.stack ? err.stack : err));
  console.log(`FAIL  the run did not finish - ${err && err.message ? err.message : err}`);
} finally {
  await panel.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// Nothing this harness started may outlive it: Playwright closes the browser, the panel is stopped, and the pid it
// was given is checked here rather than assumed - a leaked Chromium or profile directory is the one thing a capture
// harness can leave behind.
const alive = browserPids.filter((pid) => pid && alivePid(pid));
out.reaped = { browserPids, alive, sandbox: dir, sandboxRemoved: !existsSync(dir), profile: profileDir, shots: SHOTS };
console.log(`      browser pid ${browserPids.join(", ") || "(none found)"}; still alive after close: ${alive.length ? alive.join(", ") : "none"}`);
console.log(`      reaped: ${dir} (panel sandbox${existsSync(dir) ? " STILL PRESENT" : ", removed"}); profile ${profileDir || "(not reported)"}${profileDir && !existsSync(profileDir) ? " (removed by the close)" : ""}`);

// The ledger and the page are COMMITTED, so no line in them may name a folder on this machine (the repo's own
// absolute-paths gate refuses it, and a drive letter is a path exactly one machine can open). Every path a step
// recorded is written relatively: inside this tree from its root, and everything under the OS temp dir as `<tmp>/`.
// The console lines above keep the real paths, because the run's own record is what they are for.
function scrubString(v) {
  const tree = path.resolve(TREE);
  const tmp = path.resolve(tmpdir());
  return String(v)
    .split(tree + path.sep)
    .join("")
    .split(tmp + path.sep)
    .join("<tmp>/")
    .split(tree)
    .join(".")
    .split(tmp)
    .join("<tmp>")
    .split(path.sep)
    .join("/");
}
function scrubDeep(v) {
  if (typeof v === "string") return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]));
  return v;
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(scrubDeep(out), null, 2));
  console.log(`      ledger ${JSON_OUT}`);
}
if (HTML_OUT) {
  // Built from the real paths, so its image links are computed against the report's own folder, then scrubbed: the
  // links are relative already and the scrub leaves them alone.
  writeFileSync(HTML_OUT, scrubString(reportHtml(out)));
  console.log(`      report ${HTML_OUT}`);
}
console.log(`\n${checks - failures}/${checks} checks held${failures ? `, ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);

// ---- the page of what was measured ---------------------------------------------------------------------------
// A reader opens this, not a transcript: each state is its own picture with the numbers that state was measured at,
// and the shots are linked beside it so a flat PNG can be looked at on its own.
function reportHtml(ledger) {
  const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const dirOf = HTML_OUT ? path.dirname(path.resolve(HTML_OUT)) : process.cwd();
  const rel = (file) => path.relative(dirOf, file).replace(/\\/g, "/");
  const stateOf = (name) => (ledger.states && ledger.states[name]) || null;
  const screens = ledger.screens || [];
  const rows = screens
    .map((sc, i) => {
      const st = stateOf(sc.name) || {};
      const cells = [
        `${String(i).padStart(2, "0")} ${sc.name}`,
        st.vars ? st.vars.rows : "",
        st.bodyH == null ? "" : `${st.bodyH}px`,
        st.dots == null ? "none" : JSON.stringify(st.dots),
        st.dotsVisible === true ? "inside the fold" : st.dots == null ? "" : "OUTSIDE THE FOLD",
        st.padLeft == null ? "" : `${st.padLeft}px`,
        st.cardMarginLeft == null ? "" : `${st.cardMarginLeft}px`,
        st.cardMarginTop == null ? "" : `${st.cardMarginTop}px`,
        st.pre && st.turn ? `${st.pre.left - st.turn.left}px` : "",
      ];
      return `<tr><td>${esc(cells[0])}</td>${cells.slice(1).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;
    })
    .join("\n");
  const figures = screens
    .map((sc) => {
      const st = stateOf(sc.name) || {};
      return `<figure id="${esc(sc.name)}">
  <a href="${esc(rel(sc.file))}"><img src="${esc(rel(sc.file))}" alt="${esc(sc.name)}"></a>
  <figcaption><b>${esc(sc.name)}</b> - rows ${esc(st.vars ? st.vars.rows : "")}, body ${esc(st.bodyH)}px, dots ${esc(st.dots == null ? "none" : st.dots)}, padding ${esc(st.padLeft)}px, side ${esc(st.cardMarginLeft)}px, blank above ${esc(st.cardMarginTop)}px, console tab ${esc(st.pre && st.turn ? st.pre.left - st.turn.left : "")}px</figcaption>
</figure>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The console command card's fold marker and spacing</title>
<style>
  body { margin: 0; padding: 28px 32px 60px; background: #0d1117; color: #cfd8e3; font: 14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 6px; color: #e6edf6; }
  p.lede { max-width: 1080px; color: #9fb0c3; }
  .num { color: #7ee787; }
  table { border-collapse: collapse; margin: 18px 0 30px; font: 12px/1.4 ui-monospace, Consolas, monospace; }
  th, td { border-bottom: 1px solid #222a36; padding: 5px 10px; text-align: left; white-space: nowrap; }
  th { color: #8b9bb0; font-weight: 600; }
  figure { margin: 0 0 34px; }
  figure img { display: block; max-width: 100%; border: 1px solid #222a36; border-radius: 6px; }
  figcaption { margin-top: 7px; color: #9fb0c3; font-size: 12.5px; }
  code { color: #ffd479; }
</style>
</head>
<body>
<h1>The console command card: fold marker and spacing</h1>
<p class="lede">Measured in headless Chromium on a throwaway panel at 1440x1100, device scale 2. The card is the
assistant's command card in the open turn's console: one prompt long enough to wrap past eight preview rows, and one
short prompt that fits its rows. Every default is the look the panel had before these settings: <span class="num">2
preview rows of 18px</span>, <span class="num">8px</span> of padding, <span class="num">0</span> side margin,
<span class="num">0</span> blank lines, and the console's <span class="num">10px</span> text inset inside its box.</p>
<table>
<thead><tr><th>state</th><th>--cmd-rows</th><th>body</th><th>marker</th><th>marker box</th><th>padding</th><th>side</th><th>blank above</th><th>console tab</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
${figures}
</body>
</html>
`;
}
