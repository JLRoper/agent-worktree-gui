// The assistant header's search, proved in a real browser against a real panel process.
//
// WHAT IT ASSERTS, in the order the reader would meet it:
//
//   1. THE ROW DID NOT GROW. The title row measures the same with the box in it as with the box's own display set to
//      none - the control is 20px, the chips beside it are 21.94px, and the bar's height is its tallest child plus
//      its padding. It also draws BETWEEN the mode chip and the chips row, which is the gap it was asked to fill.
//   2. IT REACHES PAST THE PAGE. A card holds five turns; the phrase below lives on the oldest turn the store keeps
//      for the assistant, so it is provably not in the DOM before the search. The box finds it, the count prints
//      matched/displayed, and a click on the row loads the page that turn lives on through `wtTurnFold.reveal` and
//      marks the match inside the turn.
//   3. `*` IS A WILDCARD. A second query, typed as plain text with a `*` in it, answers from the same store and its
//      counts are printed.
//   4. A BRACKET DOES NOT THROW. `[` compiles as a literal bracket on both sides; the page records no error and the
//      count stays a number. (The zero case is test/turn-search.test.js's; this is the live half.)
//
// HOW TO RUN:  node tools/verify-assistant-search.mjs
//              node tools/verify-assistant-search.mjs --seed <dir>   (defaults to ~/.wag/state)
//              node tools/verify-assistant-search.mjs --keep          (leave the sandbox and its screenshot)
//
// It boots THIS checkout's server.js on a free port with its own state directory, seeded with a COPY of the reader's
// job store when one is present and with a synthesized eighteen-turn store when it is not. No live panel is touched.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, createVerifier, startPanel } from "./panel-testkit.mjs";
import { loadPlaywright, withBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const keep = argv.includes("--keep");
const seedDir = argOf("seed", process.env.WAG_STATE_DIR || path.join(os.homedir(), ".wag", "state"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-assistant-search"));
const shotPath = path.join(dir, "assistant-search-header.png");

const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

// ---- the seed -----------------------------------------------------------------------------------------------
// The reader's own turns when they are there, and a store with the same shape when they are not: the gate must be
// runnable on a machine that has never opened the panel.
const SEED_FILES = ["jobs.json", "assistants.json", "assistant.json", "roles.json"];
const logsDir = path.join(dir, "logs");
mkdirSync(logsDir, { recursive: true });
let seeded = 0;
for (const name of SEED_FILES) {
  const from = path.join(seedDir, name);
  if (!existsSync(from)) continue;
  try {
    copyFileSync(from, path.join(logsDir, name));
    seeded += 1;
  } catch {
    /* a file the machine cannot read is one the synthesized store covers */
  }
}

const synth = () => {
  const assistants = { version: 2, assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: "panel-assistant" }] };
  const turns = [];
  for (let i = 1; i <= 18; i += 1) {
    turns.push({
      id: `synth${String(i).padStart(2, "0")}`,
      thread: "panel-assistant",
      turn: i,
      origin: "assistant",
      status: "done",
      startedAt: new Date(Date.UTC(2026, 10, 1, 8, i, 0)).toISOString(),
      prompt: i === 2 ? "the helium balloon budget was approved in march" : `synthetic turn ${i}: keep the board quiet`,
      finalMessage: `synthetic reply ${i}`,
      lines: [{ kind: "tool", text: `read public/app.js for turn ${i}`, at: Date.now() - (18 - i) * 60000 }],
    });
  }
  return { jobs: { version: 3, savedAt: new Date().toISOString(), jobs: turns }, assistants };
};
if (!existsSync(path.join(logsDir, "jobs.json")) || !existsSync(path.join(logsDir, "assistants.json"))) {
  const s = synth();
  for (const [name, body] of [
    ["jobs.json", s.jobs],
    ["assistants.json", s.assistants],
  ]) {
    const p = path.join(logsDir, name);
    if (!existsSync(p)) {
      // write through the same JSON shape the panel writes
      writeFileSync(p, JSON.stringify(body, null, 1), "utf8");
      seeded += 1;
    }
  }
}

// ---- pick the assistant and the phrase ----------------------------------------------------------------------
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const jobsRaw = readJson(path.join(logsDir, "jobs.json"));
const jobs = Array.isArray(jobsRaw) ? jobsRaw : Array.isArray(jobsRaw?.jobs) ? jobsRaw.jobs : Object.values(jobsRaw?.jobs || {});
const assistantsRaw = readJson(path.join(logsDir, "assistants.json"));
const assistants = Array.isArray(assistantsRaw) ? assistantsRaw : assistantsRaw?.assistants || [];
if (!assistants.length || !jobs.length) fail("the seed has no assistant records or no turns");

// The assistant with the most turns: the one whose card is guaranteed to page.
const byThread = new Map();
for (const job of jobs) {
  const t = String(job.thread || "");
  if (!t) continue;
  if (!byThread.has(t)) byThread.set(t, []);
  byThread.get(t).push(job);
}
let target = null;
for (const rec of assistants) {
  const turns = byThread.get(String(rec.threadId || "")) || [];
  if (!turns.length) continue;
  if (!target || turns.length > target.turns.length) target = { rec, turns };
}
if (!target) fail("no seeded assistant has any turns");
const PER_PAGE = 5;
const oldest = [...target.turns].sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")))[0];
const pages = Math.ceil(target.turns.length / PER_PAGE);
if (pages < 3) fail(`the seed has only ${target.turns.length} turns for ${target.rec.id}, which is not several pages`);

// A distinctive phrase from the START of the oldest turn's prompt: the head renders the prompt whole, so a phrase at
// its start is in the DOM once its page is drawn, and nowhere in the DOM while its page is not.
const promptText = String(oldest.prompt || "").replace(/\s+/g, " ").trim();
const words = promptText.split(" ").slice(0, 6).join(" ");
const phrase = words.length >= 8 ? words : promptText.slice(0, 40);
if (!phrase) fail("the chosen turn has no prompt text to search for");
const wildcard = `${phrase.split(" ")[0]}*${phrase.split(" ").slice(-1)[0]}`;

console.log(`seed: ${seeded} files from ${seedDir}`);
console.log(`assistant: ${target.rec.id} (${target.rec.name}) thread ${target.rec.threadId}, ${target.turns.length} turns, ${pages} pages of ${PER_PAGE}`);
console.log(`oldest turn: ${oldest.id} (turn ${oldest.turn}) - phrase ${JSON.stringify(phrase)}`);
console.log(`wildcard query: ${JSON.stringify(wildcard)}`);

// ---- the browser --------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN: no playwright on this machine, so nothing above was checked in a page");
  process.exit(2);
}

const panel = await startPanel({ root: ROOT, dir, keep, reuseConfig: false });
const v = createVerifier();
const errors = [];
try {
  const browserHalf = await withBrowser(
    async ({ page }) => {
      page.on("pageerror", (err) => errors.push(String(err?.message || err)));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-assistant", { timeout: 45000 });
      await page.click("#btn-assistant");
      await page.waitForSelector("#assistant:not([hidden]) #as-chat", { timeout: 20000 });
      // The assistant under test, on its Chat pane.
      const tab = `#as-tabs [data-as-tab="${target.rec.id}"]`;
      if (await page.locator(tab).count()) await page.click(tab);
      await page.click('#as-subtabs [data-as-subtab="chat"]');
      await page.waitForSelector("#as-chat [data-turn]", { timeout: 20000 });
      await page.waitForTimeout(800);

      // 1. the row: same height with the box, and the box in the gap
      const geom = await page.evaluate(() => {
        const bar = document.querySelector("#assistant > .as-bar");
        const search = document.getElementById("as-search");
        const mode = document.getElementById("as-mode");
        const chips = document.getElementById("as-chips");
        const round = (n) => Math.round(n * 100) / 100;
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { left: round(r.left), right: round(r.right), top: round(r.top), bottom: round(r.bottom), w: round(r.width), h: round(r.height) };
        };
        const withBox = round(bar.getBoundingClientRect().height);
        const keep = search.style.display;
        search.style.display = "none";
        const withoutBox = round(bar.getBoundingClientRect().height);
        search.style.display = keep;
        return {
          withBox,
          withoutBox,
          mode: box(mode),
          search: box(search),
          chips: box(chips),
          chipsText: chips.textContent.trim(),
          inputH: box(document.getElementById("as-search-q")).h,
        };
      });
      v.ok("the title row is the same height with the search box as without it", geom.withBox === geom.withoutBox, `${geom.withBox}px vs ${geom.withoutBox}px`);
      v.ok("the box is shorter than the chips row beside it", geom.inputH <= geom.chips.h, `input ${geom.inputH}px, chips ${geom.chips.h}px`);
      v.ok("the box sits after the mode chip", geom.search.left >= geom.mode.right, `mode ends ${geom.mode.right}, search starts ${geom.search.left}`);
      v.ok("the box sits before the chips row", geom.search.right <= geom.chips.left + 0.5, `search ends ${geom.search.right}, chips start ${geom.chips.left}`);
      console.log(`      chips row reads ${JSON.stringify(geom.chipsText)}`);

      // 2. the phrase is NOT on the drawn page, and the box finds it in the store
      const before = await page.evaluate((p) => {
        const ids = [...document.querySelectorAll("#as-chat [data-turn]")].map((el) => el.dataset.turn);
        return { ids, text: document.getElementById("as-chat").innerText, hit: document.getElementById("as-chat").innerText.toLowerCase().includes(p.toLowerCase()) };
      }, phrase);
      v.ok("the phrase is not on the rendered page before the search", before.hit === false, `${before.ids.length} turns drawn`);
      v.ok("the turn holding the phrase is not among the drawn turns", !before.ids.includes(oldest.id), `drawn: ${before.ids.join(", ")}`);

      const typeQuery = async (q) => {
        await page.fill("#as-search-q", q);
        await page.waitForFunction((query) => {
          const n = document.getElementById("as-search-n");
          return Boolean(n && !n.hidden && n.dataset.searchQuery === query && Number(n.dataset.searchMatched) > 0);
        }, q, { timeout: 8000 });
        return page.evaluate(() => {
          const n = document.getElementById("as-search-n");
          const pop = document.getElementById("as-search-pop");
          const rows = [...pop.querySelectorAll("[data-search-hit]")];
          return {
            count: n.textContent.trim(),
            matched: Number(n.dataset.searchMatched),
            displayed: Number(n.dataset.searchDisplayed),
            title: n.title,
            rows: rows.map((r) => ({ where: r.querySelector(".as-search-where")?.textContent, snip: r.querySelector(".as-search-snip")?.textContent })),
          };
        });
      };

      const found = await typeQuery(phrase);
      console.log(`      query ${JSON.stringify(phrase)} -> count ${found.count} | ${found.title}`);
      v.ok("the phrase answered from the store", found.matched >= 1, `${found.matched} matched, ${found.displayed} displayed`);
      v.ok("the count prints matched/displayed", /^\d+\/\d+$/.test(found.count), found.count);
      v.ok("the first result row is the reader's own input", found.rows[0]?.where === "you", JSON.stringify(found.rows[0]?.where));

      // an independent read of the same endpoint, so the number on the panel is not the only witness
      const api = await fetch(`${panel.base}/api/assistant/search?q=${encodeURIComponent(phrase)}&scope=all&limit=10&assistantId=${encodeURIComponent(target.rec.id)}`);
      const apiBody = await api.json();
      v.ok("the endpoint the panel called answers the same counts", apiBody.matched === found.matched && apiBody.displayed === found.displayed, `${apiBody.matched}/${apiBody.displayed} over HTTP`);

      // 3. the click: the page holding the turn, the turn unfolded, the match marked in it
      await page.click('#as-search-pop [data-search-hit="0"]');
      await page.waitForSelector(`#as-chat [data-turn="${oldest.id}"]`, { timeout: 8000 });
      const landed = await page.evaluate((id) => {
        const el = document.querySelector(`#as-chat [data-turn="${id}"]`);
        const mark = el?.querySelector("mark.as-search-mark");
        return {
          drawn: [...document.querySelectorAll("#as-chat [data-turn]")].map((x) => x.dataset.turn),
          mark: mark ? mark.textContent : null,
          inViewport: el ? el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < window.innerHeight : false,
          popHidden: document.getElementById("as-search-pop").hidden,
        };
      }, oldest.id);
      v.ok("the hit loaded the page that contains it", landed.drawn.includes(oldest.id), `page now draws ${landed.drawn.join(", ")}`);
      v.ok("the match is marked inside the turn", Boolean(landed.mark) && landed.mark.toLowerCase().includes(phrase.split(" ")[0].toLowerCase()), JSON.stringify(landed.mark));
      v.ok("the turn is on screen", landed.inViewport === true);

      // 4. `*` as plain text in the query
      const starred = await typeQuery(wildcard);
      console.log(`      query ${JSON.stringify(wildcard)} -> count ${starred.count} | ${starred.title}`);
      v.ok("a query with * answers as a wildcard", starred.matched >= 1, `${starred.matched} matched, ${starred.displayed} displayed`);

      // 5. the cap: a broad query matches more than the list can show, and the input still comes first
      const broad = await typeQuery("the");
      console.log(`      query "the" -> count ${broad.count} | ${broad.title}`);
      v.ok("a broad query matches more than it displays", broad.matched > broad.displayed, `${broad.matched} matched, ${broad.displayed} displayed`);
      v.ok("the count still prints both numbers", broad.count === `${broad.matched}/${broad.displayed}`, broad.count);
      v.ok("the capped list leads with the reader's own input", broad.rows.length > 0 && broad.rows[0].where === "you", JSON.stringify(broad.rows.slice(0, 3).map((r) => r.where)));
      v.ok("the capped count says the input is kept first", /kept first/.test(broad.title), broad.title);

      // 5b. a bracket: a literal, and no error in the page
      await page.fill("#as-search-q", "[");
      await page.waitForFunction(() => document.getElementById("as-search-n")?.dataset.searchQuery === "[", null, { timeout: 8000 });
      const bracket = await page.evaluate(() => {
        const n = document.getElementById("as-search-n");
        return { hidden: n.hidden, text: n.textContent.trim(), matched: Number(n.dataset.searchMatched) };
      });
      v.ok("a query for [ answers a number, never a throw", Number.isFinite(bracket.matched), `count hidden=${bracket.hidden} matched=${bracket.matched}`);
      v.ok("no page error was raised by any query", errors.length === 0, errors.slice(0, 3).join(" | "));

      // 6. the picture: the header with the box, a capped count and the capped list
      await page.fill("#as-search-q", "the");
      await page.waitForFunction(() => {
        const n = document.getElementById("as-search-n");
        return Boolean(n && !n.hidden && n.dataset.searchQuery === "the" && Number(n.dataset.searchMatched) > Number(n.dataset.searchDisplayed));
      }, null, { timeout: 8000 });
      await page.screenshot({ path: shotPath, clip: await (async () => {
        const r = await page.evaluate(() => {
          const a = document.getElementById("as-search").getBoundingClientRect();
          const b = document.getElementById("as-search-pop").getBoundingClientRect();
          const bar = document.querySelector("#assistant > .as-bar").getBoundingClientRect();
          const left = Math.min(a.left, b.left, bar.left) - 12;
          const right = Math.max(a.right, b.right, bar.right) + 12;
          const top = bar.top - 10;
          const bottom = Math.max(b.bottom, bar.bottom) + 12;
          return { x: left, y: top, width: right - left, height: bottom - top };
        });
        return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.round(r.width), height: Math.round(r.height) };
      })() });
      return { geom, found, starred, bracket, landed };
    },
    { viewport: { width: 1760, height: 1000 }, deviceScaleFactor: 2 },
  );
  console.log(`screenshot: ${shotPath}`);
  if (!browserHalf) fail("the browser half returned nothing");
} finally {
  await panel.stop();
}

console.log(`\n${v.checks - v.failures}/${v.checks} checks passed`);
if (v.failures) process.exit(1);
console.log(`assistant-search: OK (sandbox ${keep ? dir : "removed"})`);
