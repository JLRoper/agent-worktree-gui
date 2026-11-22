// A TO's card, beside a SPAWN's card, at 1440 - driven in a real browser, on a throwaway panel.
// HARNESS: LIVE GATE - a seeded fixture, so it runs anywhere Playwright is installed.
//
//   node tools/verify-to-card.mjs                       # this checkout
//   node tools/verify-to-card.mjs --shots <dir>         # where the captures go
//   node tools/verify-to-card.mjs --report <file>       # the evidence page (default docs/reports/to-card-<date>.html)
//
// THE CHANGE. The assistant's QUEUE and SPAWN lines have been drawn inside the panel's console card since the card
// existed; a TO was left as prose because it addresses a WORKER thread rather than the panel's own command. That
// reason was about OWNERSHIP, not readability, and a TO is the one line in a reply a worker actually acts on - the
// hardest of them to find in a wall of prose. So TO is a card now, with its own colon grammar (`TO <thread>: <text>`,
// the first colon after the thread and no other), and its message is NOT folded: the card's body is the frame's own
// shut body, opened by the head every other card has, so the whole message is one press away and no two-line preview
// can read as if it were the whole of it. Nothing about the send path changed: lib/assistant/actions.js is untouched.
//
// WHAT IS DRIVEN (nothing synthetic reaches the page): a throwaway panel of its own (tools/panel-testkit.mjs - spare
// port, own PANEL_CONFIG / HERMES_HOME / jobs.json, API_SERVER_KEY empty), a dead apiServer and the board assistant
// OFF, so no gateway is called at all; a job store seeded with THREE settled turns in ONE thread, the newest drawn
// OPEN:
//
//   1  a plain reply
//   2  a plain reply
//   3  prose, then TO <thread>: <a message long enough to wrap past two rows>, SPAWN IN #12 ..., NOTE: ...
//
// WHAT IT ASSERTS, off the painted transcript at 1440x900:
//   (1) the TO line is a card whose head is its emoji and its THREAD, with the line itself on it;
//   (2) the TO card carries NO clamp: no data-code-clamp, no is-clamped, the body the frame's own shut body;
//   (3) a real press on its head opens the WHOLE message - aria-expanded true, the body on the page, and its height
//       is its scroll height (nothing is cut) and more than the two rows a SPAWN card folds to;
//   (4) the SPAWN beside it is still folded to two rows, before and after the press - the two cards differ in exactly
//       the one way the reader asked for;
//   (5) the NOTE beside them is a card, and the prose above them is still prose;
//   (6) no press raised a page error, and the panel's store the page read is byte-for-byte what it was.
//
// Captures: `<shots>/to-card-1440.png` (the viewport, before the press), `<shots>/to-card-1440-cards.png` (the two
// cards tight, the TO shut) and `<shots>/to-card-1440-open.png` (the same pair with the TO opened).
// The evidence page embeds all three inline, so it opens on its own with no server and no build step.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-to-card-shots")));
const DAY = new Date().toISOString().slice(0, 10);
const REPORT = path.resolve(opt("--report", path.join(TREE, "docs", "reports", `to-card-${DAY}.html`)));
const THREAD = "panel-assistant";
const CARD = `#assistant .job[data-thread="${THREAD}"]`;

// The message a worker acts on. Long on purpose: at the rail's width it wraps past two rows, which is the whole
// point - a two-row clamp would hide the end of it, and the card must show all of it when opened.
const TO_TEXT =
  "read the row and the card at docs/reports/to-card-2026-11-22.html:1, then land the pair at 1440: the message a worker acts on is never cut, and the colon after this thread is the only field break in the line";
const TO_LINE = `TO wtgui-worker-a: ${TO_TEXT}`;
const SPAWN_LINE = "SPAWN IN #12 agent-worktree-gui | [TO card] cut the tree and prove the pair at 1440";
const NOTE_LINE = "NOTE: the rail was resized, nothing else moved.";
const PROSE = "I read the row and the card is the fix, so here is the reply to the worker.";
const REPLY = [PROSE, TO_LINE, "", SPAWN_LINE, "", NOTE_LINE].join("\n");

let checks = 0;
let failures = 0;
const out = { tree: TREE, steps: [], errors: [] };
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);

// ---- the fixture -------------------------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-to-card-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
const now = Date.now();
// The tree the fixture's turns are filed under: derived from the checkout being served, never a path from the machine
// this harness was written on (the repo's own absolute-paths gate refuses one in a committed file).
const seedPath = path.join(TREE, ".worktrees", "to-card-fixture-0001").replace(/\\/g, "/");
const texts = ["the first reply, nothing to do.", "the second reply, still nothing.", REPLY];
const jobs = texts.map((text, i) => {
  const at = now - (texts.length - i) * 600_000;
  return {
    id: `tocard${i + 1}`,
    thread: THREAD,
    turn: i + 1,
    prompt: `fixture turn ${i + 1}`,
    status: "done",
    exitCode: 0,
    startedAt: new Date(at).toISOString(),
    endedAt: new Date(at + 30_000).toISOString(),
    durationMs: 30_000,
    finalMessage: text,
    cwd: seedPath,
    ownerPath: seedPath,
    worktreePath: seedPath,
    worktree: "to-card-fixture-0001",
    // ONE console line carrying the whole message, newlines and all - the shape lib/jobs.js pushes for a final
    // message, so the transcript proof drives the physical-line expansion the console draws it through.
    lines: [{ kind: "text", text, lid: i + 1, at: at + 1000 }],
  };
});
const jobsFile = path.join(dir, "logs", "jobs.json");
writeFileSync(jobsFile, JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));
const storeHash = () => createHash("sha256").update(readFileSync(jobsFile)).digest("hex");
const storeBefore = storeHash();

const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log(notRun("the TO card beside a SPAWN card", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)"));
  process.exit(2);
}

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

let shots = {};
try {
  console.log(`TO card gate on ${TREE}`);
  console.log(`  sandbox: ${panel.base} · ${jobs.length} seeded turns in ${THREAD} · no gateway · shots ${SHOTS}`);
  mkdirSync(SHOTS, { recursive: true });
  await withBrowser(
    async ({ page, pageErrors }) => {
      // The rail is the panel's remembered state, not a press: after a load it is already open.
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
      const storeAtLoad = storeHash();

      // The transcript of the open (newest) turn, read off the painted page: every command card, its head, its fold
      // state, and the prose rows around it.
      const readTranscript = (id) => {
        const turn = document.querySelector(`#assistant .job[data-thread="panel-assistant"] .turn[data-turn="${id}"]`);
        const pre = turn ? turn.querySelector("pre.job-out") : null;
        if (!pre) return null;
        const cards = [...pre.querySelectorAll(".code-box.is-cmd")].map((box) => {
          const head = box.querySelector(".code-head");
          const bodyEl = box.querySelector(".code-body");
          return {
            ltext: box.getAttribute("data-ltext"),
            what: head && head.querySelector(".code-what") ? String(head.querySelector(".code-what").textContent || "").trim() : "",
            count: head && head.querySelector(".code-n") ? String(head.querySelector(".code-n").textContent || "").trim() : "",
            aria: head ? head.getAttribute("aria-expanded") : null,
            clamp: box.getAttribute("data-code-clamp"),
            clamped: box.classList.contains("is-clamped"),
            open: box.classList.contains("is-open"),
            bodyHidden: bodyEl ? bodyEl.hidden : null,
            bodyText: bodyEl ? String(bodyEl.textContent || "").trim() : "",
            bodyH: bodyEl ? Math.round(bodyEl.getBoundingClientRect().height) : null,
            bodyScroll: bodyEl ? Math.round(bodyEl.scrollHeight) : null,
            lineH: bodyEl ? Math.round(parseFloat(getComputedStyle(bodyEl).lineHeight) || 0) : null,
          };
        });
        return {
          cards,
          prose: [...pre.querySelectorAll(".md-para .jl")].map((row) => String(row.textContent || "").trim()),
          box: (() => {
            const b = pre.getBoundingClientRect();
            return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
          })(),
        };
      };

      let transcript = await page.evaluate(readTranscript, jobs[2].id);
      if (!transcript) {
        out.errors.push("the open turn's console body was not on the page");
        console.log("NOT MEASURED  the open turn's console body was not on the page");
        return;
      }
      out.steps.push({ step: "transcript", ...transcript });
      const to = transcript.cards.find((c) => c.ltext === TO_LINE);
      const spawn = transcript.cards.find((c) => c.ltext === SPAWN_LINE);
      const noteCard = transcript.cards.find((c) => c.ltext === NOTE_LINE);

      // ---- (1) the TO is a card, with its thread on the head ------------------------------------------------
      check(Boolean(to), "the TO line is drawn as a card in the transcript");
      check(Boolean(to) && to.what === "\u{1F4E8} wtgui-worker-a", "its head is the kind's emoji and its thread", to ? to.what : "(no card)");
      check(Boolean(to) && to.bodyText.includes(TO_TEXT), "and the whole message is in its body, as written", to ? `${to.bodyText.length} chars` : "(no card)");

      // ---- (2) the TO is never clamped --------------------------------------------------------------------
      check(Boolean(to) && to.clamp === null && to.clamped === false, "the TO card carries no clamp at all", to ? `clamp ${to.clamp} · clamped ${to.clamped}` : "(no card)");
      check(Boolean(to) && to.bodyHidden === true && to.aria === "false", "its body is the frame's own shut body until the head is pressed", to ? `hidden ${to.bodyHidden} · aria ${to.aria}` : "(no card)");
      check(
        transcript.cards.filter((c) => c.clamp === null).length === 1,
        "and it is the only unclamped card in the transcript - every other kind folds as it did",
        JSON.stringify(transcript.cards.map((c) => c.clamp)),
      );

      // ---- (3) the SPAWN beside it is still folded to two rows --------------------------------------------
      check(Boolean(spawn), "the SPAWN line beside it is a card too");
      check(Boolean(spawn) && spawn.what === "\u{1F331} IN #12 agent-worktree-gui | TO card", "with the SPAWN emoji, the tree, and the title the payload leads with", spawn ? spawn.what : "(no card)");
      check(Boolean(spawn) && spawn.clamp === "2" && spawn.clamped === true, "folded to the two rows a SPAWN card has always had", spawn ? `clamp ${spawn.clamp} · clamped ${spawn.clamped}` : "(no card)");
      check(Boolean(noteCard) && noteCard.what === "\u{1F4DD} NOTE", "and the NOTE beside them is a card", noteCard ? noteCard.what : "(no card)");
      check(transcript.prose.includes(PROSE), "the prose above them is still prose", JSON.stringify(transcript.prose));

      // ---- (4) the captures, BEFORE the press: the TO card shut, the SPAWN card folded beside it --------------
      // The reader asked to see a carded TO beside a carded SPAWN; this is that pair in its resting state, at 1440.
      const clipOf = (to, spawn) => page.evaluate(({ toText, spawnText }) => {
        const of = (text) => {
          const box = [...document.querySelectorAll("#assistant .code-box.is-cmd")].find((b) => b.getAttribute("data-ltext") === text);
          if (!box) return null;
          const r = box.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        const a = of(toText);
        const b = of(spawnText);
        if (!a || !b) return null;
        const x = Math.max(0, Math.min(a.x, b.x) - 12);
        const y = Math.max(0, Math.min(a.y, b.y) - 12);
        return {
          x,
          y,
          width: Math.max(a.x + a.width, b.x + b.width) - x + 12,
          height: Math.max(a.y + a.height, b.y + b.height) - y + 12,
        };
      }, { toText: to, spawnText: spawn });
      const files = {};
      files.viewport = path.join(SHOTS, "to-card-1440.png");
      await page.screenshot({ path: files.viewport });
      note(`screenshot ${files.viewport}`);
      files.cards = path.join(SHOTS, "to-card-1440-cards.png");
      const before = await clipOf(TO_LINE, SPAWN_LINE);
      await page.screenshot(before ? { path: files.cards, clip: before } : { path: files.cards });
      note(`screenshot ${files.cards}`);

      // ---- (5) one press opens the WHOLE message ----------------------------------------------------------
      const toHead = page.locator(`${CARD} .turn[data-turn="${jobs[2].id}"] .code-box[data-ltext="${TO_LINE.replace(/"/g, '\\"')}"] .code-head`).first();
      await toHead.click();
      await page.waitForTimeout(300);
      transcript = await page.evaluate(readTranscript, jobs[2].id);
      const opened = transcript.cards.find((c) => c.ltext === TO_LINE);
      out.steps.push({ step: "opened", ...(opened || {}) });
      check(Boolean(opened) && opened.aria === "true" && opened.open === true && opened.bodyHidden === false, "a press opens it: aria-expanded true and the body on the page", opened ? `aria ${opened.aria} · hidden ${opened.bodyHidden}` : "(no card)");
      check(Boolean(opened) && opened.bodyH >= opened.bodyScroll - 2, "the whole message is on the page - nothing cut", opened ? `${opened.bodyH}px vs ${opened.bodyScroll}px` : "(no card)");
      check(Boolean(opened) && opened.lineH > 0 && opened.bodyH > opened.lineH * 2 + 2, "and it is more than the two rows a SPAWN card folds to", opened ? `${opened.bodyH}px at a ${opened.lineH}px line` : "(no card)");
      // The SPAWN beside it did not move.
      const spawnAfter = transcript.cards.find((c) => c.ltext === SPAWN_LINE);
      check(Boolean(spawnAfter) && spawnAfter.clamp === "2" && spawnAfter.clamped === true, "the SPAWN card beside it is untouched by that press", spawnAfter ? `clamp ${spawnAfter.clamp}` : "(no card)");
      files.open = path.join(SHOTS, "to-card-1440-open.png");
      const after = await clipOf(TO_LINE, SPAWN_LINE);
      await page.screenshot(after ? { path: files.open, clip: after } : { path: files.open });
      note(`screenshot ${files.open}`);
      shots = files;

      // ---- (6) display only: the store the page read did not move, and no page error --------------------
      check(storeAtLoad === storeHash(), "the store the page read is byte-for-byte what it was after the press", `${storeAtLoad.slice(0, 16)} -> ${storeHash().slice(0, 16)}`);
      check(pageErrors.length === 0, "no press raised a page error", pageErrors.slice(0, 3).join(" | "));
      out.errors = pageErrors;
      out.store = { seeded: storeBefore, atLoad: storeAtLoad, after: storeHash() };
      out.shots = shots;
    },
    // The reader's own width, for the card the reader asked to see beside its neighbour. A 1x device scale keeps the
    // committed evidence page light: the shot IS 1440x900, the width the brief names.
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
} finally {
  await panel.stop().catch(() => {});
}

// ---- the evidence page ---------------------------------------------------------------------------------------------
// Self-contained: the shots ride inline as data URIs and every sentence is this run's own. No machine path is written
// into it (the repo's absolute-paths gate refuses one, and the scratch folder is gone by the next run anyway).
const b64 = (file) => (shots && file ? readFileSync(file).toString("base64") : "");
const img = (file) => (b64(file) ? `<img alt="the TO card beside the SPAWN card" src="data:image/png;base64,${b64(file)}">` : "<p class=missing>(the capture was not taken)</p>");
const row = (v) => `<tr><td>${v[0]}</td><td>${v[1]}</td></tr>`;
const passed = checks - failures;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>A TO card beside a SPAWN card, at 1440</title>
<style>
 body{background:#0f1319;color:#dbe4f0;font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:32px 40px 60px;}
 h1{font-size:23px;margin:0 0 4px;} h2{font-size:17px;margin:30px 0 8px;color:#9fc4ee;}
 .sub{color:#8b9bb0;margin:0 0 20px;}
 table{border-collapse:collapse;margin:10px 0 4px;} td{border:1px solid #263141;padding:5px 10px;vertical-align:top;}
 td:first-child{color:#8b9bb0;white-space:nowrap;}
 .verdict{font-weight:700;color:${failures ? "#ff8f8f" : "#7fe0a4"};}
 img{max-width:100%;border:1px solid #263141;border-radius:6px;margin:10px 0 4px;display:block;}
 code,pre{font:13px/1.5 ui-monospace,Consolas,monospace;color:#c8d6e6;}
 pre{background:#141a22;border:1px solid #263141;border-radius:6px;padding:12px;white-space:pre-wrap;}
 .cap{color:#8b9bb0;font-size:13px;margin:0 0 18px;}
 .missing{color:#ff8f8f;}
</style></head><body>
<h1>A TO card beside a SPAWN card, at 1440</h1>
<p class="sub">agent-worktree-gui · ${DAY} · a real panel, a seeded thread, Playwright at 1440x900. Display only: the
line the panel sends is byte-for-byte the line that was written.</p>
<p class="verdict">${passed}/${checks} checks held${failures ? ` - ${failures} failed` : ""}.</p>

<h2>The reply</h2>
<pre>${PROSE}
${TO_LINE}

${SPAWN_LINE}

${NOTE_LINE}</pre>

<h2>The two cards, tight - the TO shut</h2>
${img(shots && shots.cards)}
<p class="cap">The TO card is shut, unclamped and headed by its thread; the SPAWN card below it is folded to its two
rows. This is the pair at rest, at the reader's own 1440 width.</p>

<h2>The same pair, with the TO opened by its head</h2>
${img(shots && shots.open)}
<p class="cap">One press on the head every card has, and the whole message is on the page - no clamp, nothing cut.
Only the TO grew: the SPAWN card beside it is still folded to two rows.</p>

<h2>The reader's own screen, 1440 wide</h2>
${img(shots && shots.viewport)}
<p class="cap">The transcript of the open turn at 1440x900, with the rail open, before the press.</p>

<h2>What the run measured</h2>
<table>${[
  ["the TO line", "a card, head 📨 wtgui-worker-a, the whole line in its body"],
  ["the TO's fold", "no data-code-clamp, not is-clamped; the body is the frame's shut body until the head is pressed"],
  ["a press on its head", "aria-expanded true, the body on the page, its height equal to its scroll height"],
  ["the SPAWN beside it", "still clamped to two rows, before and after the press"],
  ["the NOTE beside them", "a card (📝 NOTE), as before"],
  ["the prose above them", "still prose - no line swallowed by a card"],
  ["the store the page read", "unchanged (sha256 of the seeded jobs file, before and after)"],
  ["page errors", "none"],
].map(row)}</table>
</body></html>
`;
mkdirSync(path.dirname(REPORT), { recursive: true });
writeFileSync(REPORT, html, "utf8");
console.log(`report ${REPORT}`);

if (failures) {
  console.log(`${checks - failures}/${checks} checks held`);
  process.exit(1);
}
console.log(`${checks}/${checks} checks held`);
