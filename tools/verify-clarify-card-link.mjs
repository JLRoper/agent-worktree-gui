// The clarify card's question is a sentence, and a URL in it is a LINK.
//
//   node tools/verify-clarify-card-link.mjs
//
// HARNESS: LIVE GATE
//
// WHAT THIS IS. A parked agent asks for a decision by raising a clarify card, and the decision often needs
// the thing the question names: a report, a page, a run. The card used to print the question as ESCAPED TEXT,
// so the URL ended the sentence as something to copy. public/app.js `questionPrompt` now renders the question
// through `linkifyText` (public/core/dom-format.js), which escapes the text and then wraps each http(s) URL in
// the panel's own anchor: class `out-link`, `target="_blank"`, and `data-open-url`, which the page's click
// handler turns into POST /api/open-url so the OS browser opens the page.
//
// HOW IT IS PROVED, AND WHY NOT BY READING THE SOURCE. `questionPrompt` is sliced out of public/app.js and
// `esc` / `linkifyText` out of public/core/dom-format.js - the SHIPPED functions, with only the card's own
// read state handed in - and the markup that returns is written onto a page that loads the shipped
// public/style.css. A real Chromium opens it, reads the anchor's attributes and computed style, and CLICKS
// it: the click has to open the smoke-test report, which is then captured. So the evidence is a picture of
// the card and a picture of the page the link opened, not an assertion that one would.
//
// The captured files are the report's figures:
//   docs/reports/assets/clarify-card-link-2026-11-09/card.png    the card, with the link in its question
//   docs/reports/assets/clarify-card-link-2026-11-09/opened.png  the report the click opened
//
// PORT. The card's URL must be an http(s) one (linkifyText links nothing else), so the page and the report are
// served from a local static server rooted at this checkout. CLARIFY_CARD_PORT moves it off the default.
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withBrowser } from "./browser.mjs";
import { sliceBetween } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = Number(process.env.CLARIFY_CARD_PORT || 7411);
const SHOT_DIR = path.join(ROOT, "docs", "reports", "assets", "clarify-card-link-2026-11-09");
const CARD_SHOT = path.join(SHOT_DIR, "card.png");
const OPENED_SHOT = path.join(SHOT_DIR, "opened.png");
const CARD_PATH = "/card-page.html";
const REPORT_REL = "docs/reports/clarify-card-link-smoke-2026-11-09.html";
const REPORT_URL = `http://127.0.0.1:${PORT}/${REPORT_REL}`;

// The question the card carries: ONE complete sentence that names the report and the decision wanted. The
// URL is the report's own, so a click has a page to open and the capture has something to prove.
const QUESTION = `The smoke-test report at ${REPORT_URL} is ready - should it ship as the panel's decided fix?`;
const CHOICES = [
  "Ship it as the fix (Recommended)",
  "Keep the link, reword the rule",
  "Hold the card change",
];

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? `: ${extra}` : ""}`);
  }
};

// ---- the shipped question row, rendered with the shipped helpers ------------------------------------
// Same slices the test uses (test/clarify-question-link.test.js): the page's own function, so a change to the
// card is measured here without this harness growing a second copy of the markup.
function cardMarkup() {
  const page = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const dom = readFileSync(path.join(ROOT, "public", "core", "dom-format.js"), "utf8");
  const source = [
    sliceBetween(dom, "const esc = (s) =>", "\n// A path as a card"),
    sliceBetween(dom, "const OUT_URL_RE", "\nfunction fmtBytes"),
    // The card's Links section and the browser name a file link uses: `questionPrompt` draws both, and a slice that
    // left them out would fail on a ReferenceError instead of measuring the card.
    sliceBetween(page, "const browserName =", "function paintQLook"),
    sliceBetween(page, "function questionLinks(q) {", "function questionPrompt("),
    sliceBetween(page, "const RECOMMENDED_RE", "// ---- the question box's look (Settings > Display)"),
    sliceBetween(page, 'function questionPrompt(turn, copy = "")', '// "~49m left"'),
  ].join("\n");
  const build = new Function(
    "turnLive", "questionInFlight", "qLookState", "fmtLeft", "questionPicks", "questionDrafts", "questionBrowser",
    `${source}\nreturn { questionPrompt };`,
  );
  const turn = {
    id: "turn-smoke",
    thread: "wtgui-clarify-link",
    status: "running",
    questionDone: false,
    question: { question: QUESTION, choices: CHOICES, requestId: "p-smoke" },
  };
  return build(
    () => true,
    () => null,
    { typed: false },
    () => "10m",
    new Map(),
    new Map(),
    null,
  ).questionPrompt(turn);
}

// ---- a static server rooted at this checkout --------------------------------------------------------
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serve(pageHtml) {
  const server = createServer((req, res) => {
    let rel = "/";
    try {
      rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400).end("bad url");
      return;
    }
    if (rel === CARD_PATH) {
      res.writeHead(200, { "Content-Type": TYPES[".html"] });
      res.end(pageHtml);
      return;
    }
    const file = path.resolve(ROOT, `.${rel}`);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

const cardPage = (markup) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>a parked clarify card - the smoke-test report link in its question</title>
<link rel="stylesheet" href="/public/style.css">
<style>
  body { padding: 28px 22px 60px; }
  .stage { max-width: 980px; margin: 0 auto; }
  .cap { margin: 0 0 14px; font: 11.5px/1.5 var(--mono, ui-monospace, monospace); color: var(--dim); }
  .job { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px 16px; }
</style>
</head>
<body>
<main class="stage">
  <p class="cap">public/app.js questionPrompt - the shipped question row, on the shipped public/style.css</p>
  <div class="job" data-thread="wtgui-clarify-link">
${markup}
  </div>
</main>
</body>
</html>
`;

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });

  // ---- 1. the markup the card produces -------------------------------------------------------------
  const markup = cardMarkup();
  ok("the question row is drawn", markup.includes('class="tq-question"'));
  ok("the URL is the panel's own anchor", markup.includes(`<a class="out-link" href="${REPORT_URL}"`),
    "linkifyText's out-link, not a hand-built tag");
  ok("the anchor opens in a new tab", markup.includes('target="_blank"'), "a click cannot navigate the board away");
  ok("the anchor carries the panel's open target", markup.includes(`data-open-url="${REPORT_URL}"`),
    "the click handler turns this into POST /api/open-url");
  const questionRow = /<div class="tq-question">([\s\S]*?)<\/div>/.exec(markup)?.[1] || "";
  ok("the link is inside the question", questionRow.includes("<a class=\"out-link\""), "not in the note or a choice");
  ok("the question is one complete sentence", (QUESTION.match(/\?/g) || []).length === 1 && QUESTION.trim().endsWith("?"),
    "one question mark, at the end");
  ok("the sentence names the report", QUESTION.includes(REPORT_URL), "the report's own URL");
  ok("the sentence names the decision", /should it ship/.test(QUESTION), "the decision the reader is asked for");

  const pageHtml = cardPage(markup);
  const server = await serve(pageHtml);
  try {
    const reportRes = await fetch(REPORT_URL);
    ok("the report the link names is served", reportRes.status === 200, `${REPORT_URL} answered ${reportRes.status}`);
    const reportText = await reportRes.text();
    const title = /<title>([^<]+)<\/title>/.exec(reportText)?.[1] || "";
    ok("the report is a page a reader can read", title.length > 0, title);

    // ---- 2. a real browser: the rendered link, then the click ----------------------------------------
    const shots = await withBrowser(async ({ page, pageErrors }) => {
      await page.setViewportSize({ width: 1024, height: 720 });
      await page.goto(`http://127.0.0.1:${PORT}${CARD_PATH}`, { waitUntil: "load" });
      await page.waitForSelector(".turn-question .tq-question a.out-link", { state: "visible", timeout: 20_000 });

      const link = await page.evaluate(() => {
        const a = document.querySelector(".turn-question .tq-question a.out-link");
        const box = a.getBoundingClientRect();
        const cs = getComputedStyle(a);
        return {
          href: a.getAttribute("href"),
          target: a.getAttribute("target"),
          rel: a.getAttribute("rel"),
          open: a.dataset.openUrl || "",
          text: a.textContent,
          underline: cs.textDecorationLine,
          color: cs.color,
          questionColor: getComputedStyle(a.closest(".tq-question")).color,
          cursor: cs.cursor,
          width: box.width,
          height: box.height,
        };
      });
      ok("the rendered link points at the report", link.href === REPORT_URL, link.href);
      ok("the rendered link says the report's URL", link.text === REPORT_URL);
      ok("the link is visibly a link", /underline/.test(link.underline), `${link.underline} in ${link.color}`);
      ok("the link reads apart from the question", link.color !== link.questionColor, `${link.color} vs ${link.questionColor}`);
      ok("the link is a target a reader can hit", link.width > 40 && link.height > 8, `${Math.round(link.width)}x${Math.round(link.height)}`);
      ok("the link takes the hand cursor", link.cursor === "pointer", link.cursor);
      ok("the page raised no error", pageErrors.length === 0, pageErrors.join("; "));

      await page.locator(".turn-question").screenshot({ path: CARD_SHOT });

      // The click. A popup is the proof the anchor opened a PAGE, and its URL is the proof it is the report.
      const [opened] = await Promise.all([
        page.waitForEvent("popup", { timeout: 20_000 }),
        page.click(".turn-question .tq-question a.out-link"),
      ]);
      await opened.waitForLoadState("domcontentloaded");
      await opened.waitForTimeout(150);
      ok("the click opens the report", opened.url() === REPORT_URL, opened.url());
      const openedTitle = await opened.title();
      ok("the opened page is the smoke-test report", /smoke test/i.test(openedTitle), openedTitle);
      await opened.setViewportSize({ width: 1100, height: 900 });
      await opened.screenshot({ path: OPENED_SHOT });
      return { title: openedTitle };
    }, { viewport: { width: 1024, height: 720 }, deviceScaleFactor: 2 });

    console.log(`\nshots:  ${path.relative(ROOT, CARD_SHOT).replace(/\\/g, "/")}`);
    console.log(`        ${path.relative(ROOT, OPENED_SHOT).replace(/\\/g, "/")}`);
    console.log(`report: ${REPORT_URL}`);
    console.log(`${checks} checks, ${failures} failed`);
    return failures === 0 && shots ? 0 : 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.log(`FAIL  the harness did not finish: ${String((e && e.message) || e)}`);
    process.exit(2);
  });
