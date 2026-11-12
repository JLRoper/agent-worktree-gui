// The docked console, captured with the SAME child message before and after the markdown repair:
//
//   node tools/capture-docked-console.mjs --out docs/assets/docked-console-markdown/after.png
//   node tools/capture-docked-console.mjs --width 480 --out .../after-480.png     # the docked rail
//   PANEL_ROOT=<extracted base> node tools/capture-docked-console.mjs --out .../before.png --expect broken
//
// The page is a fixture, but the surface in it is the real one: the root's public/style.css, its core/dom-format.js,
// core/console-format.js and core/console-markdown.js, and its public/board/console.js - and then the shipped
// `subConsoleHtml` is called with the message as lib/subagents.js stores it (ONE line, its newlines inside) and the
// result is dropped under a real sub-row. So the before and after pictures differ only by the root being served.
//
// `--expect fixed` (the default) asserts the repair: a div, blocks, bold, the code chip, no source marker, both
// controls, the violet token, and a real press that moves the colour and saves it. `--expect broken` asserts the
// base's behaviour, so the before capture says what it is a picture of.
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPage, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PANEL_ROOT ? path.resolve(process.env.PANEL_ROOT) : path.join(HERE, "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback = "") => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = path.resolve(argOf("--out", path.join(ROOT, "docs/assets/docked-console-markdown/console.png")));
const EXPECT = argOf("--expect", "fixed");
// The reader's window. 1440x900 is a desktop panel; 480 is the docked rail's own width (style.css names it), where
// the longest line and the widest code chip have the least room.
const WIDTH = Number(argOf("--width", "1440")) || 1440;
const HEIGHT = Number(argOf("--height", "900")) || 900;

// The row's message: the TL;DR, a bullet whose first words are bold, a double-backtick span around a file:line path,
// and a bold that opens on one line and closes on the next.
const MESSAGE = [
  "TL;DR:",
  "- **The screenshot shows the real defect**: the docked console prints the source, not the rendered text.",
  "- **Filed with #3**, and `` `render-projects.js:690-705` `` arrives literally.",
  "- The surface is public/core/console-markdown.js:119-124, which already bolds.",
  "**The box is a pre",
  "and it never asks the renderer.**",
].join("\n");

let failures = 0;
let checks = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? `: ${extra}` : ""}`);
  }
  return Boolean(cond);
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>docked console</title>
<link rel="stylesheet" href="/public/style.css">
</head>
<body style="margin:0;padding:18px;background:#0d1117">
<div class="subagents mono" id="host">
  <span class="sub-head" role="button" tabindex="0"><span class="sub-chev">\u25be</span> \u29c9 1 subagent \u00b7 all done</span>
  <div class="sub-row is-open" role="button" tabindex="0" data-sub-console="child-docked-console">
    <span class="sub-caret sub-chev">\u25be</span><span class="sub-dot"></span>
    <span class="sub-title">fix the docked console</span>
    <span class="sub-meta mono">done \u00b7 1m 14s</span>
  </div>
</div>
<script src="/public/core/dom-format.js"></script>
<script src="/public/core/console-format.js"></script>
<script src="/public/core/console-markdown.js"></script>
<script src="/public/board/console.js"></script>
<script>
  // The console's own state, as app.js seeds it, and nothing else: the renderers below read these by bare name.
  window.state = {
    subConsoles: new Map(),
    subConsoleReads: new Map(),
    subConsolePinned: new Map(),
    openSubConsole: new Set(),
    collapsedSubs: new Set(),
    codeBoxShut: new Set(),
    foldRows: new Map(),
    toolStore: new Map(),
    typed: new Map(),
    thinkPinned: new Map(),
    thinkLoading: new Set(),
    thinkOpen: new Set(),
    openFences: new Set(),
    toolGroups: new Map(),
  };
  window.toolGroupsOn = () => false;
  window.paintSubagents = () => {};
  window.apiFetch = () => Promise.reject(new Error("no api in the fixture"));
  window.state.subConsoles.set("child-docked-console", {
    lines: [{ kind: "text", text: ${JSON.stringify(MESSAGE)}, lid: null }],
    running: false,
    loading: false,
  });
  window.state.openSubConsole.add("child-docked-console");
  document.getElementById("host").insertAdjacentHTML("beforeend", subConsoleHtml("child-docked-console"));
</script>
</body></html>`;

const TYPES = { ".css": "text/css", ".js": "text/javascript", ".html": "text/html", ".png": "image/png" };

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function main() {
  console.log(`\n== fixture over ${ROOT}`);
  const { server, base } = await serve();
  try {
    const result = await withBrowser(async ({ page }) => {
      // The capture's preference: the violet token at the console's own margin, set BEFORE the paint that is shot.
      await page.addInitScript(() => {
        localStorage.setItem("wtgui.subConsoleFg", "violet");
        localStorage.setItem("wtgui.subConsoleMargin", "36");
      });
      await openPage(page, base, { selector: ".sub-console" });
      await page.waitForTimeout(250);

      const m = await page.evaluate(() => {
        const box = document.querySelector(".sub-console");
        if (!box) return null;
        const wrap = box.closest(".sub-console-wrap");
        const cs = getComputedStyle(box);
        return {
          tag: box.tagName,
          whiteSpace: cs.whiteSpace,
          color: cs.color,
          marginLeft: wrap ? getComputedStyle(wrap).marginLeft : null,
          text: box.innerText,
          strong: box.querySelectorAll("strong").length,
          code: box.querySelectorAll("code.md-code").length,
          blocks: box.querySelectorAll(".md-block").length,
          list: box.querySelectorAll(".md-block.md-list .md-li").length,
          pre: box.querySelectorAll("pre").length,
          overflowX: box.scrollWidth - box.clientWidth,
          controls: {
            color: Boolean(wrap && wrap.querySelector("[data-sub-console-color]")),
            margin: Boolean(wrap && wrap.querySelector("[data-sub-console-margin]")),
          },
        };
      });
      if (!ok("the child's console is on the page", Boolean(m))) return;
      console.log(`      tag ${m.tag} - white-space ${m.whiteSpace} - colour ${m.color} - margin ${m.marginLeft}`);

      if (EXPECT === "broken") {
        ok("the base prints the message inside a pre", m.tag === "PRE", m.tag);
        ok("the base preserves the source's whitespace", m.whiteSpace === "pre-wrap", m.whiteSpace);
        ok("the base prints the bullets as dashes, not a list", m.text.includes("\n- The screenshot") && m.blocks === 0, `${m.blocks} blocks`);
        ok("the base leaves stray backticks around the file:line path", m.text.includes("` render-projects.js:690-705 `"));
        ok("the base leaks the bold that spans the line break", m.text.includes("**The box is a pre"));
        ok("the base offers no colour or margin control", !m.controls.color && !m.controls.margin);
      } else {
        ok("the box is a div, not a pre of source", m.tag === "DIV" && m.pre === 0, m.tag);
        ok("the box no longer preserves the source's whitespace", m.whiteSpace !== "pre-wrap", m.whiteSpace);
        ok("the bullets are a list", m.list >= 2, `${m.list} items`);
        ok("the bold is drawn", m.strong >= 3, `${m.strong} strong`);
        ok("the file:line span is a code chip", m.code >= 1, `${m.code} code`);
        ok("no literal ** reaches the reader", !m.text.includes("**"), JSON.stringify(m.text.slice(0, 80)));
        ok("the path is on screen", m.text.includes("render-projects.js:690-705"));
        ok("both controls are offered", m.controls.color && m.controls.margin);
        ok("the text colour is the violet TOKEN", m.color === "rgb(163, 113, 247)", m.color);
        ok("the margin is the saved step", m.marginLeft === "36px", m.marginLeft);
        ok("nothing runs past the box's right edge", m.overflowX <= 1, `${m.overflowX}px over at ${WIDTH}`);
      }

      // The picture, taken before the control is exercised, so both captures show the same message in the same state.
      mkdirSync(path.dirname(OUT), { recursive: true });
      await page.locator(".subagents").first().screenshot({ path: OUT });
      console.log(`\ncapture: ${OUT}`);

      if (EXPECT === "fixed") {
        // A real press, at the listener the shipped console.js registered: the ring moves, the preference is saved,
        // and the box repaints in the next token's colour.
        await page.click("[data-sub-console-color]");
        await page.waitForTimeout(120);
        const after = await page.evaluate(() => {
          const box = document.querySelector(".sub-console");
          return { color: box ? getComputedStyle(box).color : null, saved: localStorage.getItem("wtgui.subConsoleFg") };
        });
        ok("a press moves the colour and saves it", after.saved === "text" && after.color === "rgb(230, 233, 239)", `${after.saved} / ${after.color}`);
      }
    }, { viewport: { width: WIDTH, height: HEIGHT } });
    if (result && result.skipped) {
      console.log("BROWSER-HALF-NOT-RUN");
      failures += 1;
    }
  } finally {
    server.close();
  }
  console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} checks (${EXPECT})`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
