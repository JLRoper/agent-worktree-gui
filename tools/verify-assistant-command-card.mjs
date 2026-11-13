// The assistant's command lines, drawn as the tool card - driven in a real browser, on a throwaway panel.
// HARNESS: LIVE GATE - a seeded fixture, so it runs anywhere Playwright is installed.
//
//   node tools/verify-assistant-command-card.mjs                        # this checkout
//   node tools/verify-assistant-command-card.mjs --shots <dir>          # where the captures go
//   node tools/verify-assistant-command-card.mjs --json <file>          # keep the raw ledger
//
// THE CHANGE. A reply ends with lines in the panel's own vocabulary, and the reader met them as prose. A line that
// leads with a [Title] is now drawn in the SAME card a tool's result is drawn in - one emoji for the kind, the
// recipient, the title - with its body folded to two lines and a click to read the rest. DISPLAY ONLY: the line the
// panel executes is byte-for-byte the one that was written.
//
// WHAT IS DRIVEN (nothing synthetic reaches the page): a throwaway panel of its own (tools/panel-testkit.mjs -
// spare port, own PANEL_CONFIG / HERMES_HOME / jobs.json, API_SERVER_KEY empty), a dead apiServer and the board
// assistant OFF, so no gateway is called at all; a job store seeded with FIVE settled turns in ONE thread, each
// ending on one of the lines the panel asks to see:
//
//   1  QUEUE assistant-3 | [Playwright test] <a payload long enough to wrap past two lines>   a card
//   2  QUEUE assistant-3 | [Playwright test corner resize                                     unclosed, no card
//   3  QUEUE assistant-3 | [xxxx...81...xxxx] body                                           81 characters, no card
//   4  TODO ADD [Playwright test] corner resize                                               a card
//   5  QUEUE assistant-3 | corner resize                                                      no bracket, no card
//
// WHAT IT ASSERTS, off the painted rail:
//   (1) turn 1's tail is a card whose header reads "🧾 assistant-3 | Playwright test";
//   (2) folded, its body is exactly two lines high and there is more to read under the clamp;
//   (3) a real click on the head opens it: aria-expanded flips, the caret turns, the whole body is on the page, and
//       the hint says "click to fold";
//   (4) a second click folds it back to the same two lines - the folded state is a fold, not a disappearance;
//   (5) the TODO line is a card too, with its own emoji, and the three malformed or absent lines are drawn as the
//       plain text they have always been - no card, no emoji, the line itself;
//   (6) the turn heads still open and close the turns they always did (the card did not take the tail's own press);
//   (7) no press raised a page error.
//
// Exit codes: 0 held; 1 a check failed; 2 the run did not measure what it claims (no Playwright, no rail, no turns).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-command-card-shots")));
const JSON_OUT = opt("--json");
const THREAD = "panel-assistant";
const CARD = `#assistant .job[data-thread="${THREAD}"]`;

// The five lines, in the order the turns carry them. The first one's payload is long on purpose: the card folds the
// BODY to two lines, and a body that fits on one would prove nothing about the fold.
const LONG = "corner resize the board's tail and the transcript together, with a body long enough to wrap past two display lines at the rail's width";
const PLAIN = "corner resize";
const LINES = [
  { id: "cmdcard1", text: `QUEUE assistant-3 | [Playwright test] ${LONG}`, card: true, title: "Playwright test", glyph: "\u{1F9FE}" },
  { id: "cmdcard2", text: "QUEUE assistant-3 | [Playwright test corner resize", card: false },
  { id: "cmdcard3", text: `QUEUE assistant-3 | [${"x".repeat(81)}] body`, card: false },
  { id: "cmdcard4", text: "TODO ADD [Playwright test] corner resize", card: true, title: "Playwright test", glyph: "\u2611\uFE0F" },
  { id: "cmdcard5", text: "QUEUE assistant-3 | corner resize", card: false },
  // The newest turn of the thread is the one drawn OPEN, so it needs a tail of its own that is not under test: the
  // four proof lines above it are then all folded, which is where a tail is read.
  { id: "cmdcard6", text: "nothing else to report.", card: false },
];

let checks = 0;
let failures = 0;
const out = { tree: TREE, steps: [], notMeasured: [], errors: [] };
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);

// ---- the fixture: five settled turns of the rail's own conversation ---------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-command-card-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
const now = Date.now();
// The tree the fixture's card is filed under: derived from the checkout being served, never a path from the machine
// this harness was written on.
const seedPath = path.join(TREE, ".worktrees", "command-card-fixture-0001").replace(/\\/g, "/");
const jobs = LINES.map((entry, i) => {
  const at = now - (LINES.length - i) * 600_000;
  return {
    id: entry.id,
    thread: THREAD,
    turn: i + 1,
    prompt: `fixture turn ${i + 1}`,
    status: "done",
    exitCode: 0,
    startedAt: new Date(at).toISOString(),
    endedAt: new Date(at + 30_000).toISOString(),
    durationMs: 30_000,
    finalMessage: entry.text,
    cwd: seedPath,
    ownerPath: seedPath,
    worktreePath: seedPath,
    worktree: "command-card-fixture-0001",
    lines: [{ kind: "text", text: entry.text, lid: i + 1, at: at + 1000 }],
  };
});
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));

// The kit beside the checkout being SERVED, not beside this file.
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
    // No gateway: the URL is a dead port and the assistant's own rules are off, so nothing here can start a run.
    assistant: { enabled: false },
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
  },
});

// What the painted rail says about one folded turn: the tail it draws, whether that tail is a card, the card's own
// header and state, and the two heights that say "folded to two lines" rather than "shut".
function readTail({ id, thread }) {
  const turn = document.querySelector(`#assistant .job[data-thread="${thread}"] .turn[data-turn="${id}"]`);
  if (!turn) return null;
  const peek = turn.querySelector(".turn-peek");
  const box = turn.querySelector(".code-box");
  const head = box ? box.querySelector(".code-head") : null;
  const body = box ? box.querySelector(".code-body") : null;
  return {
    find: true,
    peekText: peek ? String(peek.textContent || "").trim() : "",
    isCard: Boolean(box),
    head: head ? String(head.textContent || "").trim() : "",
    what: head && head.querySelector(".code-what") ? String(head.querySelector(".code-what").textContent || "").trim() : "",
    // Is any of the header cut off by its own box? The title is the point of the card, so a head that ellipsizes it
    // has failed even when its textContent is right.
    whatCut: head && head.querySelector(".code-what")
      ? (() => {
          const w = head.querySelector(".code-what");
          return { over: Math.round(w.scrollWidth - w.clientWidth), lines: Math.round(w.getBoundingClientRect().height) };
        })()
      : null,
    aria: head ? head.getAttribute("aria-expanded") : null,
    caret: head ? String(head.querySelector(".code-caret")?.textContent || "").trim() : null,
    hint: head ? String(head.querySelector(".code-hint")?.textContent || "").trim() : null,
    headTag: head ? head.tagName : null,
    clamp: box ? box.getAttribute("data-code-clamp") : null,
    clamped: box ? box.classList.contains("is-clamped") : null,
    open: box ? box.classList.contains("is-open") : null,
    bodyHidden: body ? body.hidden : null,
    bodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
    bodyScroll: body ? Math.round(body.scrollHeight) : null,
    lineH: body ? Math.round(parseFloat(getComputedStyle(body).lineHeight) || 0) : null,
  };
}

const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log(notRun("the assistant's command card", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)"));
  process.exit(2);
}

try {
  console.log(`assistant command card gate on ${TREE}`);
  console.log(`  sandbox: ${panel.base} · ${LINES.length} seeded turns in ${THREAD} · no gateway · shots ${SHOTS}`);
  mkdirSync(SHOTS, { recursive: true });
  await withBrowser(
    async ({ page, pageErrors }) => {
      // The rail is the panel's remembered state, not a press: after a reload it is already open.
      await page.addInitScript(() => {
        try {
          localStorage.setItem("wm.assistantOpen", "1");
        } catch {
          /* a browser with storage off still draws the rail on its own default */
        }
      });
      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`${CARD} .turn`, { timeout: 45_000 });
      await page.waitForTimeout(900);

      const read = async (id) => page.evaluate(readTail, { id, thread: THREAD });
      const boxOf = async (id) => {
        const el = await page.$(`${CARD} .turn[data-turn="${id}"] .code-box`);
        if (!el) return null;
        const box = await el.boundingBox();
        return box ? { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 6), width: box.width + 12, height: box.height + 12 } : null;
      };
      const shot = async (name, clip = null) => {
        const file = path.join(SHOTS, `${name}.png`);
        await page.screenshot(clip ? { path: file, clip } : { path: file });
        note(`screenshot ${file}`);
        return file;
      };

      // ---- (1) the newest page of a six-turn thread: the four lines the panel asks to see, folded ------------
      // Five turns a page, and the newest is drawn OPEN, so the proof lines below it are the ones with a tail:
      // turns 2 (unclosed bracket), 3 (81 characters), 4 (a TODO with a bracket) and 5 (no bracket at all).
      for (const entry of LINES.slice(1, 5)) {
        await page.waitForFunction(
          (id) => Boolean(document.querySelector(`#assistant .job[data-thread="panel-assistant"] .turn[data-turn="${id}"]`)),
          entry.id,
          { timeout: 20_000 },
        ).catch(() => {});
      }
      const todo = await read(LINES[3].id);
      out.steps.push({ step: "todo", ...todo });
      if (!todo) {
        out.notMeasured.push("the TODO turn was not on the page");
        console.log("NOT MEASURED  the TODO turn was not on the page");
        return;
      }
      check(todo.isCard, "a bracket on a TODO line is a card too");
      check(todo.what === `${LINES[3].glyph} Playwright test`, "with the TODO emoji and the title", todo.what);
      for (const entry of LINES.slice(1, 3).concat(LINES.slice(4, 5))) {
        const plain = await read(entry.id);
        out.steps.push({ step: "plain", id: entry.id, ...plain });
        check(plain && plain.peekText === entry.text, `no card, the line itself: ${entry.text.slice(0, 34)}...`, plain ? plain.peekText.slice(0, 40) : "(turn missing)");
        check(Boolean(plain) && !plain.isCard, `and no emoji or header stands in for it: ${entry.text.slice(0, 30)}...`);
      }
      await shot("01-malformed-and-absent");

      // ---- (2) one page back: the QUEUE card's own tail ------------------------------------------------------
      // Six turns are two pages ("2-6" then "1-1"), and the card is on the older one. The arrows are the reader's
      // own gesture, so this is a real press and not a seeded fold.
      await page.locator(`${CARD} button[data-turn-page="older"]`).click();
      await page.waitForTimeout(400);
      await page.waitForSelector(`${CARD} .turn[data-turn="${LINES[0].id}"]`, { timeout: 20_000 }).catch(() => {});
      let tail = await read(LINES[0].id);
      if (!tail) {
        out.notMeasured.push("the rail's card turn was not on the older page");
        console.log("NOT MEASURED  the rail's card turn was not on the older page");
        return;
      }
      out.steps.push({ step: "folded", ...tail });
      check(tail.isCard, "the QUEUE line is drawn as a card in the board's tail");
      check(tail.headTag === "BUTTON", "the card's head is a real button (Tab reaches it, Enter and Space press it)", tail.headTag);
      check(tail.what === `${LINES[0].glyph} assistant-3 | Playwright test`, "the header reads: the kind's emoji, the recipient, the title", tail.what);
      check(tail.whatCut && tail.whatCut.over <= 1, "and none of it is cut off: the title wraps rather than ellipsizing", JSON.stringify(tail.whatCut));
      check(tail.aria === "false" && tail.clamped === true && tail.bodyHidden === false, "folded: aria-expanded false, clamped, body on the page", `aria ${tail.aria} · clamped ${tail.clamped} · hidden ${tail.bodyHidden}`);
      check(tail.bodyH !== null && tail.lineH > 0 && tail.bodyH <= tail.lineH * 2 + 2, "folded, the body is exactly two lines high", `${tail.bodyH}px at a ${tail.lineH}px line`);
      check(tail.bodyScroll > tail.bodyH, "and there is more of it to read under the clamp", `${tail.bodyScroll}px of body in ${tail.bodyH}px`);
      await shot("02-queue-card-folded", await boxOf(LINES[0].id));

      // ---- (3) a real press on the head opens it -------------------------------------------------------------
      await page.locator(`${CARD} .turn[data-turn="${LINES[0].id}"] .code-head`).click();
      await page.waitForTimeout(250);
      tail = await read(LINES[0].id);
      out.steps.push({ step: "expanded", ...tail });
      check(tail.aria === "true" && tail.open === true && tail.clamped === false, "the press opens the card: aria-expanded true, unclamped", `aria ${tail.aria} · open ${tail.open}`);
      check(tail.caret === "▾", "the caret turns to point down", tail.caret);
      check(tail.hint === "click to fold", "and the head offers the way back", tail.hint);
      check(tail.bodyH >= tail.bodyScroll - 2, "the whole body is on the page now", `${tail.bodyH}px vs ${tail.bodyScroll}px of body`);
      check(tail.bodyH > tail.lineH * 2 + 2, "which is more than the two lines it was folded to", `${tail.bodyH}px`);
      await shot("03-queue-card-expanded", await boxOf(LINES[0].id));

      // ---- (4) a second press folds it back to the same two lines --------------------------------------------
      await page.locator(`${CARD} .turn[data-turn="${LINES[0].id}"] .code-head`).click();
      await page.waitForTimeout(250);
      tail = await read(LINES[0].id);
      out.steps.push({ step: "folded-again", ...tail });
      check(tail.aria === "false" && tail.clamped === true && tail.bodyHidden === false, "a second press folds it back and the body stays on the page", `aria ${tail.aria} · clamped ${tail.clamped}`);
      check(tail.bodyH <= tail.lineH * 2 + 2, "back to exactly two lines", `${tail.bodyH}px`);
      await shot("04-queue-card-folded-again", await boxOf(LINES[0].id));

      // ---- (5) the turn's own head still folds the turn ------------------------------------------------------
      await page.locator(`${CARD} .turn[data-turn="${LINES[0].id}"] .turn-head`).click();
      await page.waitForTimeout(300);
      const openedTurn = await page.evaluate(
        (id) => {
          const turn = document.querySelector(`#assistant .job[data-thread="panel-assistant"] .turn[data-turn="${id}"]`);
          return turn ? { folded: turn.classList.contains("folded"), hasConsole: Boolean(turn.querySelector("pre.job-out")) } : null;
        },
        LINES[0].id,
      );
      check(Boolean(openedTurn) && !openedTurn.folded && openedTurn.hasConsole, "a press on the turn head still opens that turn, as it always did", JSON.stringify(openedTurn));

      // ---- (6) the transcript: the Messages pane draws the same card from the same module ---------------
      // A reply is filed as a message when its turn ends, so this pane is where a reader meets the line after the
      // fact. It is the same component on the same text: a second surface, not a second card.
      await page.locator("#as-subtabs [data-as-subtab=\"messages\"]").click();
      await page.waitForSelector("#as-messages .as-msg", { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(400);
      const pane = await page.evaluate(() => {
        const host = document.querySelector("#as-messages");
        if (!host) return null;
        const cards = [...host.querySelectorAll(".code-box.is-cmd")].map((box) => ({
          what: box.querySelector(".code-what")?.textContent?.trim() || "",
          clamp: box.getAttribute("data-code-clamp"),
          clamped: box.classList.contains("is-clamped"),
          bodyHidden: box.querySelector(".code-body")?.hidden ?? null,
          bodyH: Math.round(box.querySelector(".code-body")?.getBoundingClientRect().height || 0),
        }));
        return { entries: host.querySelectorAll(".as-msg").length, cards };
      });
      out.steps.push({ step: "transcript", ...(pane || {}) });
      check(Boolean(pane) && pane.entries > 0, "the Messages pane drew the thread's replies", pane ? `${pane.entries} entries` : "(no pane)");
      const card = pane && pane.cards.find((c) => c.what === `${LINES[0].glyph} assistant-3 | Playwright test`);
      check(Boolean(card), "and the reply's QUEUE line is the same card there, with the same header", card ? card.what : JSON.stringify(pane && pane.cards));
      check(Boolean(card) && card.clamp === "2" && card.clamped && card.bodyHidden === false, "folded to two lines in the transcript too, body on the page", JSON.stringify(card));
      // The one form that must NOT be a card: a line the module cannot title.
      check(Boolean(pane) && !pane.cards.some((c) => c.what.includes("xxxx")), "the 81-character line draws no card in the transcript either");
      await shot("05-transcript-card");

      // ---- (6) nothing the browser did raised a page error ---------------------------------------------------
      const errs = pageErrors;
      out.errors = errs;
      check(errs.length === 0, "no press raised a page error", errs.slice(0, 3).join(" | "));
    },
    { viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2 },
  );
} finally {
  // Nothing this run started may outlive it: the throwaway panel is a whole server process, and its sandbox
  // directory goes with it.
  await panel.stop().catch(() => {});
  if (JSON_OUT) writeFileSync(path.resolve(JSON_OUT), JSON.stringify(out, null, 1));
}

if (out.notMeasured.length) {
  console.log(`NOT MEASURED: ${out.notMeasured.join("; ")}`);
  process.exit(2);
}
console.log(`${checks - failures}/${checks} checks held`);
process.exit(failures ? 1 : 0);
