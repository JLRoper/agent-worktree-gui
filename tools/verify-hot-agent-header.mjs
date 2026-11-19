// The Hot Agent search's OPENER in the floating header, driven in headless Chromium at 1440x900.
//
// HARNESS: LIVE GATE - it tracks main, and `npm run verify:hot-agent-header` is how the repo runs it by name.
//
// WHAT IT PROVES, in the order a reader meets it:
//
//   0. THE ORDER. In the header's control row the reader meets the assistant's own entry, then this control, then
//      Human - in the DOM in that order, and in that order on screen with nothing else visible between them.
//   1. THE GLYPH IS DRAWN, NOT SET. The opener carries an inline SVG (a 16-unit viewBox at 15px) and no text at all,
//      and it sits at the neighbours' size and weight: the same button height, border and radius, and a glyph within
//      two pixels of the emoji height the labels beside it render.
//   2. THE PANEL STILL OPENS FROM IT. One click opens the assistant rail if it was closed, hangs the popover under
//      THIS button (not under the rail), puts the caret in its box, and the button says aria-expanded="true".
//   3. ESCAPE closes it and hands the keyboard back to the header button.
//   4. Ctrl+Shift+Q STILL OPENS IT FROM ANYWHERE - rail closed, nothing focused - which is the chord the tooltip and
//      the aria-label name.
//   5. THE BAR IT LEFT IS INTACT. #ha-search-open is no longer a descendant of #assistant, the turn search's own box
//      is still there and untouched, and Ctrl+Q without Shift still puts the caret in that box.
//
// HOW TO RUN:  node tools/verify-hot-agent-header.mjs
//              node tools/verify-hot-agent-header.mjs --out <dir>       (defaults to docs/assets/hot-agent-header)
//              node tools/verify-hot-agent-header.mjs --keep            (leave the sandbox store behind)
//
// It boots THIS checkout's server.js on a free port with its own state directory and a three-turn store in the live
// shape, so the popover has rows to draw. No live panel is touched.
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, configureRepo, createVerifier, git, ran, startPanel } from "./panel-testkit.mjs";
import { loadPlaywright, withBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const keep = argv.includes("--keep");
const outDir = argOf("out", path.join(ROOT, "docs", "assets", "hot-agent-header"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-hot-agent-header-sandbox"));
mkdirSync(outDir, { recursive: true });
mkdirSync(dir, { recursive: true });
const shot = (name) => path.join(outDir, (name.endsWith(".png") ? name.slice(0, -4) : name) + "-1440x900.png");

// ---- two project trees, real git repos so the board can draw a card in each -------------------------------------
const repos = path.join(dir, "repos");
mkdirSync(repos, { recursive: true });
const repoOf = (name) => path.join(repos, name);
for (const name of ["project-alpha", "project-beta"]) {
  const repo = repoOf(name);
  mkdirSync(repo, { recursive: true });
  if (!ran(repo, "rev-parse", "--git-dir")) {
    git(repo, "init", "-q", "-b", "main");
    configureRepo(repo, { name: "Hot Agent Header Verify" });
    writeFileSync(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", `the ${name} fixture`);
  }
}

// ---- the store: three reader turns to worker agents, in the live shape ------------------------------------------
const at = (minutes) => new Date(Date.UTC(2026, 10, 18, 6, minutes, 0)).toISOString();
const treeOf = (name) => ({ path: repoOf(name), branch: "main", exists: true, pending: false });
const JOBS = [1, 2, 3].map((n) => {
  const project = n % 2 === 0 ? "project-beta" : "project-alpha";
  return {
    id: `hdr-${n}`,
    title: `header pass ${n}`,
    thread: `wtgui-header-${String(n).padStart(2, "0")}`,
    turn: 1,
    status: "done",
    startedAt: at(n),
    endedAt: at(n + 1),
    prompt: `header task ${n}: read public/index.html and say where the search button lives now`,
    finalMessage: `the agent's own reply to task ${n}`,
    projectPath: repoOf(project),
    ownerPath: repoOf(project),
    tree: treeOf(project),
    branch: "main",
    assistant: false,
    reply: false,
    origin: null,
    lines: [],
  };
});
mkdirSync(path.join(dir, "logs"), { recursive: true });
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ version: 3, savedAt: new Date().toISOString(), jobs: JOBS }, null, 1), "utf8");
writeFileSync(
  path.join(dir, "logs", "assistants.json"),
  JSON.stringify({ version: 2, assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: "panel-assistant" }] }, null, 1),
  "utf8",
);

// ---- the browser ------------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN: no playwright on this machine, so nothing was checked in a page");
  process.exit(2);
}

const panel = await startPanel({ root: ROOT, dir, keep });
const v = createVerifier();
const record = { viewport: "1440x900", steps: [], screenshots: [] };
try {
  await withBrowser(
    async ({ page, withPage }) => {
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err?.message || err)));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      const shoot = async (name, extra = {}) => {
        const p = shot(name);
        await page.screenshot({ path: p, ...extra });
        record.screenshots.push(path.basename(p));
        return p;
      };
      // One read of the header and the bar it left.
      const look = () =>
        page.evaluate(() => {
          const bar = document.querySelector(".topbar .controls");
          const opener = document.getElementById("ha-search-open");
          const assistantBtn = document.getElementById("btn-assistant");
          const humanBtn = document.getElementById("btn-human");
          const svg = opener ? opener.querySelector("svg") : null;
          const box = (el) => {
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
          };
          const kids = bar ? [...bar.children] : [];
          const visible = [...(bar?.querySelectorAll("button") || [])].filter((b) => !b.hidden && b.offsetParent !== null);
          // The emoji labels' own line box: what "the size of its neighbours" means for a glyph set as type.
          const label = humanBtn?.querySelector("#human-label");
          let emojiH = null;
          if (label && label.firstChild) {
            const range = document.createRange();
            range.selectNodeContents(label.firstChild);
            const r = range.getBoundingClientRect();
            emojiH = r.height ? Math.round(r.height * 10) / 10 : null;
          }
          const style = (el) => {
            const s = getComputedStyle(el);
            return { radius: s.borderTopLeftRadius, border: s.borderTopWidth, font: s.fontSize, color: s.color };
          };
          const pop = document.getElementById("ha-search-pop");
          const input = document.getElementById("ha-search-q");
          return {
            domOrder: { assistant: kids.indexOf(assistantBtn), opener: kids.indexOf(opener), human: kids.indexOf(humanBtn) },
            visibleIds: visible.map((b) => b.id || b.className),
            visibleBoxes: visible.map((b) => ({ id: b.id || b.className, ...box(b) })),
            opener: opener ? { ...box(opener), text: opener.textContent.trim(), aria: opener.getAttribute("aria-label"), title: opener.getAttribute("title"), expanded: opener.getAttribute("aria-expanded") } : null,
            svg: svg ? { vb: svg.getAttribute("viewBox"), ...box(svg), paths: svg.querySelectorAll("path,rect").length, stroked: [...svg.querySelectorAll("[stroke]")].length } : null,
            emojiH,
            btnStyle: { opener: opener ? style(opener) : null, human: humanBtn ? style(humanBtn) : null, assistant: assistantBtn ? style(assistantBtn) : null },
            heights: visible.map((b) => Math.round(b.getBoundingClientRect().height)),
            inAssistant: Boolean(document.getElementById("assistant")?.contains(opener)),
            turnSearch: Boolean(document.getElementById("as-search-q")),
            focusId: document.activeElement?.id || null,
            pop: pop ? { hidden: pop.hidden, ...box(pop), rows: pop.querySelectorAll("[data-search-hit]").length } : null,
            count: document.getElementById("ha-search-n")?.textContent.trim() || "",
            railHidden: Boolean(document.getElementById("assistant")?.hidden),
            inputValue: input ? input.value : null,
          };
        });

      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-assistant", { timeout: 45000 });
      await page.waitForSelector("#ha-search-open", { timeout: 20000 });

      // ---- 0. the order ----------------------------------------------------------------------------------------
      const first = await look();
      v.ok(
        "the header carries the opener in the DOM between the assistant's entry and Human",
        first.domOrder.assistant >= 0 && first.domOrder.opener === first.domOrder.assistant + 2 && first.domOrder.human === first.domOrder.opener + 1,
        JSON.stringify(first.domOrder),
      );
      const three = ["btn-assistant", "ha-search-open", "btn-human"];
      const joined = three.join(",");
      const ats = three.map((id) => first.visibleIds.indexOf(id));
      v.ok("all three controls are visible", ats.every((i) => i >= 0), first.visibleIds.join(" "));
      v.ok(
        "on screen they read assistant, then this one, then Human, with nothing visible between",
        ats[0] >= 0 && ats[1] === ats[0] + 1 && ats[2] === ats[1] + 1,
        `visible row: ${first.visibleIds.join(" | ")} (${joined})`,
      );
      const xOf = (id) => first.visibleBoxes.find((b) => b.id === id)?.x ?? null;
      v.ok(
        "the control sits to the LEFT of Human and to the right of the assistant's entry",
        xOf("ha-search-open") > xOf("btn-assistant") && xOf("ha-search-open") < xOf("btn-human"),
        `assistant ${xOf("btn-assistant")}px, opener ${xOf("ha-search-open")}px, human ${xOf("btn-human")}px`,
      );
      record.steps.push({ step: "order", ...first.domOrder, visible: first.visibleIds, boxes: first.visibleBoxes });
      await shoot("01-header-three-controls");

      // ---- 1. the glyph is drawn, at the neighbours' size and weight --------------------------------------------
      v.ok("the opener is an inline SVG, not an emoji", Boolean(first.svg) && first.opener.text === "", `svg ${Boolean(first.svg)}, text ${JSON.stringify(first.opener.text)}`);
      v.ok("the SVG is a 16-unit viewBox drawn at 16px", first.svg?.vb === "0 0 16 16" && first.svg.w === 16 && first.svg.h === 16, JSON.stringify({ vb: first.svg?.vb, w: first.svg?.w, h: first.svg?.h }));
      v.ok("the hand and the pen are drawn, not typed", (first.svg?.paths || 0) >= 6 && (first.svg?.stroked || 0) >= 2, `${first.svg?.paths} shapes, ${first.svg?.stroked} stroked`);
      v.ok(
        "the glyph is the emoji height beside it, within two pixels",
        first.emojiH !== null && Math.abs(first.svg.h - first.emojiH) <= 2,
        `glyph ${first.svg.h}px, the label beside it ${first.emojiH}px`,
      );
      v.ok(
        "the button is the neighbours' height, radius and border",
        new Set(first.heights).size === 1 && first.btnStyle.opener.radius === first.btnStyle.human.radius && first.btnStyle.opener.border === first.btnStyle.human.border,
        `heights ${JSON.stringify(first.heights)}, radius ${first.btnStyle.opener.radius}, border ${first.btnStyle.opener.border}px`,
      );
      v.ok(
        "the tooltip and the aria-label both name Ctrl+Shift+Q and the corpus",
        /Ctrl\+Shift\+Q/.test(first.opener.title) && /Ctrl\+Shift\+Q/.test(first.opener.aria) && /turns you wrote to worker agents/i.test(first.opener.title),
        JSON.stringify({ title: first.opener.title.slice(0, 60), aria: first.opener.aria }),
      );
      // A crisp copy of the same strip: the glyph is 16px, so this one picture is taken at 2x on a page of its own -
      // every other shot is exactly 1440x900 pixels, one per CSS pixel.
      const ctrl = first.visibleBoxes.find((b) => b.id === "btn-assistant");
      const clip = { x: ctrl.x - 8, y: ctrl.y - 8, width: Math.max(240, xOf("btn-human") - ctrl.x + 120), height: ctrl.h + 16 };
      const zoomed = shot("02-glyph-closeup");
      await withPage(
        async ({ page: page2 }) => {
          await page2.goto(panel.base, { waitUntil: "domcontentloaded" });
          await page2.waitForSelector("#ha-search-open", { timeout: 45000 });
          await page2.screenshot({ path: zoomed, clip });
        },
        { deviceScaleFactor: 2 },
      );
      record.screenshots.push(path.basename(zoomed));

      // ---- 2. the panel opens from the header control ----------------------------------------------------------
      await page.click("#ha-search-open");
      await page.waitForSelector("#ha-search-pop:not([hidden])", { timeout: 20000 });
      await page.waitForFunction(() => document.querySelectorAll("#ha-search-pop [data-search-hit]").length === 3, null, { timeout: 20000 });
      const opened = await look();
      v.ok("a click opens the assistant rail if it was closed", opened.railHidden === false, `rail hidden ${opened.railHidden}`);
      v.ok("the popover is open and holds the three turns", opened.pop.hidden === false && opened.pop.rows === 3, `rows ${opened.pop.rows}, count ${opened.count}`);
      v.ok("the caret is in the Hot Agent box", opened.focusId === "ha-search-q", `focus ${opened.focusId}`);
      v.ok("the header button says it is expanded", opened.opener.expanded === "true", String(opened.opener.expanded));
      v.ok(
        "the popover hangs under THIS button: its right edge on the button's right edge, a few pixels below it",
        Math.abs(opened.pop.right - opened.opener.right) <= 6 && opened.pop.y >= opened.opener.bottom - 2 && opened.pop.y <= opened.opener.bottom + 16,
        `button x${opened.opener.x} right${opened.opener.right} bottom${opened.opener.bottom}, popover x${opened.pop.x} right${opened.pop.right} y${opened.pop.y} w${opened.pop.w}`,
      );
      record.steps.push({ step: "opened-from-header", pop: opened.pop, focus: opened.focusId, expanded: opened.opener.expanded });
      await shoot("03-panel-from-header");

      // ---- 3. Escape closes and hands the keyboard back --------------------------------------------------------
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("ha-search-pop").hidden, null, { timeout: 10000 });
      const closed = await look();
      v.ok("Escape closes the list", closed.pop.hidden === true, `hidden ${closed.pop.hidden}`);
      v.ok("Escape hands the keyboard back to the header button", closed.focusId === "ha-search-open", `focus ${closed.focusId}`);
      v.ok("the button is no longer marked expanded", closed.opener.expanded === "false", String(closed.opener.expanded));

      // ---- 4. the chord, from anywhere, with the rail closed ---------------------------------------------------
      await page.click("#btn-as-close");
      await page.waitForFunction(() => document.getElementById("assistant").hidden, null, { timeout: 10000 });
      await page.click(".topbar", { position: { x: 4, y: 4 } });
      await page.keyboard.press("Control+Shift+q");
      await page.waitForSelector("#ha-search-pop:not([hidden])", { timeout: 20000 });
      await page.waitForFunction(() => document.querySelectorAll("#ha-search-pop [data-search-hit]").length === 3, null, { timeout: 20000 });
      const chord = await look();
      v.ok("Ctrl+Shift+Q opens it with the rail closed and nothing focused", chord.railHidden === false && chord.pop.hidden === false && chord.focusId === "ha-search-q", `rail hidden ${chord.railHidden}, focus ${chord.focusId}`);
      v.ok("the chord marks the header button expanded too", chord.opener.expanded === "true", String(chord.opener.expanded));
      record.steps.push({ step: "chord", ...{ railHidden: chord.railHidden, focus: chord.focusId } });
      await shoot("04-chord-from-board");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("ha-search-pop").hidden, null, { timeout: 10000 });

      // ---- 5. the bar it left still works ----------------------------------------------------------------------
      v.ok("the opener is no longer anywhere inside the assistant", first.inAssistant === false, `inside #assistant ${first.inAssistant}`);
      v.ok("the turn search's own box is still in the bar", first.turnSearch === true && (await page.isVisible("#as-search-q")), "as-search-q visible");
      await page.keyboard.press("Control+q");
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === "as-search-q", null, { timeout: 10000 });
      const turn = await look();
      v.ok("Ctrl+Q without Shift still puts the caret in the turn search", turn.focusId === "as-search-q", `focus ${turn.focusId}`);
      v.ok("the turn search's own popover is still wired", (await page.evaluate(() => Boolean(document.getElementById("as-search-pop")))) === true, "as-search-pop present");
      record.steps.push({ step: "turn-search", focus: turn.focusId });
      await shoot("05-assistant-bar-intact");

      v.ok("no page error was raised", errors.length === 0, errors.slice(0, 3).join(" | "));
    },
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
} finally {
  await panel.stop();
}

writeFileSync(path.join(outDir, "run.json"), JSON.stringify(record, null, 1), "utf8");
console.log(`${v.checks - v.failures}/${v.checks} checks passed  (${record.screenshots.length} screenshots in ${outDir})`);
process.exit(v.failures === 0 ? 0 : 1);
