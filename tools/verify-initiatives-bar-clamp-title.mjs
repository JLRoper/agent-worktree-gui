#!/usr/bin/env node
// THE INITIATIVES TAB'S THREE ASKS FROM ROW 295, MEASURED AT THE DOCK AND AT A WIDE FLOAT.
//
//   node tools/verify-initiatives-bar-clamp-title.mjs [--root <tree>] [--shots <dir>] [--json <file>]
//
// WHAT THIS GATE PROVES. The reader filed three asks and three assumptions, and each one has a wrong answer that still
// looks right in a screenshot. Every claim below is a number read out of the painted page at BOTH drawings of the pane
// - the 480px docked rail and a 1400px wide float, because the tab is a block below the 1000px container query and a
// two-column grid above it, and "it looks fine" at one of them is exactly how a layout ships broken at the other.
//
//   1. THE TASK BAR READS `#<id> | owner | status | <name ...>` (ask 1). Each wave member's children are mapped to
//      semantic names and the order is asserted twice - in the DOM and by GEOMETRY, sorted by line then x, so a bar
//      that wraps still has to read in that order. Both chips must sit after the id and before the title; the reports
//      chip must keep the bar's right edge; every bar must still be its section's width with no card scrollbar
//      (row 291's rule, which this change may not undo).
//   2. THE EXPANDED DESCRIPTION IS CLAMPED, AND THE WHOLE TEXT IS STILL THERE (ask 2). The body draws exactly three
//      line boxes; its textContent is the store's description byte for byte, and the last words of it are findable in
//      the page, so a find, a selection and a copy reach text that is not painted. The show more control is drawn on a
//      description that overflows and ABSENT on one that fits; pressing it draws the whole text and reads show less;
//      pressing it again clamps it back.
//   3. THE NAME IS A FULL-WIDTH ROW ABOVE BOTH COLUMNS, AND IT WRAPS LIKE THE MINIMIZED CARD (ask 3). Per card and per
//      frame: the open head's width equals the folded row's, the title's AVAILABLE width (measured by putting a long
//      unbreakable word in it) is identical in both states, and THE WORDS BREAK AT THE SAME PLACES - the line boxes are
//      compared as text, not as a count. The open title's own box fills that available width, which is what "the name
//      spans the card" means for a text box. At the wide frame the head must also sit above both columns and reach
//      across them, with the description and the projects still side by side beneath it.
//
// HARNESS: a fixture panel of its own - three throwaway git repos, the initiatives store, the wave store and two
// assistants' queues under a scratch home (tools/initiatives-fixture.mjs). WAG_HOME points at that home, so the
// reader's ~/.wag and the panel on 7331 are never read or written. Without Playwright the run says BROWSER-NOT-RUN and
// exits 2 rather than passing on a half that never ran.
//
// Exit codes: 0 green, 1 a check failed, 2 the browser half did not run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ROOT = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = opt("--shots", null);
const JSON_OUT = opt("--json", null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const load = async (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { buildFixture, startFixturePanel, waitForFixtureRows, waitForInitiativesView } = await load("tools/initiatives-fixture.mjs");
const { loadPlaywright, notRun, openPage, withBrowser } = await load("tools/browser.mjs");

if (!loadPlaywright({ root: ROOT, cwd: ROOT })) {
  notRun("verify-initiatives-bar-clamp-title");
  process.exit(2);
}

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing.\n`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const check = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  ok(name, pass, pass ? JSON.stringify(got) : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};
const note = (s) => console.log(`      ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the page-side reads ------------------------------------------------------------------------------------------
// One read of one card's name row, in either state. `avail` is the width the title's text is offered: the element's
// text is swapped for one long unbreakable word for the length of a synchronous read (no frame is drawn between), so a
// short title measures the same available width a long one would. `lines` is the WORDS on each drawn line, from one
// Range per character, so two drawings with the same widths but a different break still compare unequal.
const NAME_JS = `(id) => {
  const card = document.querySelector('[data-init-card="' + id + '"]');
  if (!card) return null;
  const cs = getComputedStyle(card);
  const cr = card.getBoundingClientRect();
  const head = card.querySelector(".init-head");
  const title = card.querySelector(".init-title");
  const tcs = getComputedStyle(title);
  const round = (n) => Math.round(n * 100) / 100;
  const boxes = (() => {
    const range = document.createRange();
    range.selectNodeContents(title);
    return [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => ({ top: round(r.top), w: round(r.width), right: round(r.right) }));
  })();
  const lines = (() => {
    const node = title.firstChild;
    if (!node || node.nodeType !== 3) return [];
    const range = document.createRange();
    const out = [];
    let lineTop = null;
    for (let i = 0; i < node.data.length; i += 1) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      const top = r.width || r.height ? Math.round(r.top * 10) / 10 : null;
      if (top !== null && (lineTop === null || Math.abs(top - lineTop) > 1)) {
        out.push("");
        lineTop = top;
      }
      if (out.length) out[out.length - 1] += node.data[i];
    }
    return out.map((s) => s.replace(/\\s+$/, ""));
  })();
  const avail = (() => {
    const before = title.textContent;
    title.textContent = "M".repeat(400);
    const w = title.getBoundingClientRect().width;
    title.textContent = before;
    return round(w);
  })();
  const hr = head.getBoundingClientRect();
  const tr = title.getBoundingClientRect();
  const cardRight = cr.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
  return {
    id,
    folded: card.classList.contains("is-titlecard"),
    head: { left: round(hr.left), right: round(hr.right), width: round(hr.width) },
    headRightFromBorder: round(cr.right - hr.right),
    card: { width: round(cr.width), contentRight: round(cardRight), left: round(cr.left) },
    scroll: { sw: card.scrollWidth, cw: card.clientWidth },
    title: { left: round(tr.left), right: round(tr.right), width: round(tr.width), height: round(tr.height) },
    avail,
    font: tcs.fontSize,
    lineHeight: tcs.lineHeight,
    boxes,
    lines,
    columns: (() => {
      const desc = card.querySelector(".init-desc");
      const side = card.querySelector(".init-side");
      const grid = getComputedStyle(card);
      const r = (el) => (el ? { left: round(el.getBoundingClientRect().left), right: round(el.getBoundingClientRect().right), top: round(el.getBoundingClientRect().top), width: round(el.getBoundingClientRect().width) } : null);
      return { areas: grid.gridTemplateAreas, desc: r(desc), side: r(side) };
    })(),
  };
}`;

// One read of an expanded description: the clamp, the words, and the control's own state. `natural` is the height the
// body needs with the clamp lifted for one read - the same measurement the pane's own paint pass takes to decide
// whether the control is drawn at all.
const CLAMP_JS = `(id) => {
  const card = document.querySelector('[data-init-card="' + id + '"]');
  if (!card) return null;
  const body = card.querySelector("[data-init-desc-body]");
  const more = card.querySelector("[data-init-desc-more]");
  if (!body) return null;
  const round = (n) => Math.round(n * 10) / 10;
  const cs = getComputedStyle(body);
  const clamped = body.classList.contains("is-clamped");
  const height = round(body.getBoundingClientRect().height);
  const lineHeight = parseFloat(cs.lineHeight) || 0;
  body.classList.remove("is-clamped");
  const natural = round(body.getBoundingClientRect().height);
  if (clamped) body.classList.add("is-clamped");
  const br = more ? more.getBoundingClientRect() : null;
  return {
    id,
    clamped,
    height,
    natural,
    lines: Math.round(height / (lineHeight || 1)),
    lineHeight,
    text: body.textContent,
    chars: body.textContent.length,
    more: more
      ? { label: more.textContent.trim(), aria: more.getAttribute("aria-expanded"), hidden: more.hidden, width: round(br.width), height: round(br.height), right: round(br.right), left: round(br.left) }
      : null,
    rowRight: (() => { const row = card.querySelector("[data-init-desc-row]"); return row ? round(row.getBoundingClientRect().right) : null; })(),
  };
}`;

// One read of every task bar in the wave lane: the children in the order they are drawn, mapped to what they SAY, and
// their geometry, so the order can be checked by the eye's rule (line, then x) and not only by the DOM.
const BARS_JS = `() => {
  const round = (n) => Math.round(n);
  const nameOf = (c) => c.classList.contains("wave-member-id") ? "id"
    : c.classList.contains("wave-owner") ? "owner"
    : c.classList.contains("wave-mstate") ? "status"
    : c.classList.contains("wave-member-title") ? "title"
    : c.classList.contains("wave-member-project") ? "project"
    : c.classList.contains("wave-reports") ? "reports"
    : "reports-list";
  return [...document.querySelectorAll("#as-initiatives .wave-member")].map((bar) => {
    const bcs = getComputedStyle(bar);
    const br = bar.getBoundingClientRect();
    const strip = bar.closest(".wave-members");
    const sr = strip.getBoundingClientRect();
    const kids = [...bar.children].map((c) => {
      const r = c.getBoundingClientRect();
      return { what: nameOf(c), text: (c.textContent || "").trim().slice(0, 26), x: round(r.left), right: round(r.right), top: round(r.top), bottom: round(r.bottom), w: round(r.width), h: round(r.height), hidden: c.hidden };
    });
    const contentRight = br.right - parseFloat(bcs.borderRightWidth) - parseFloat(bcs.paddingRight);
    // THE FIRST LINE, left to right: the items on the bar's first line, ordered by x. Every item in a flex line is
    // centred on that line, so the line is found by the items' vertical CENTRES - a three-line title's centre is its
    // line's centre, and its top is not the line's top. "The first line reads #id | owner | status | name" is the
    // fact the reader described, and this is that line.
    const visible = kids.filter((k) => k.w > 0 && k.h > 0 && !k.hidden).map((k) => ({ ...k, centre: k.top + k.h / 2 }));
    const firstCentre = Math.min(...visible.map((k) => k.centre));
    const firstLine = visible.filter((k) => Math.abs(k.centre - firstCentre) <= 2).sort((a, b) => a.x - b.x).map((k) => k.what);
    return {
      id: bar.getAttribute("data-wave-member"),
      order: kids.map((k) => k.what),
      firstLine,
      kids: visible,
      width: round(br.width),
      stripWidth: round(sr.width),
      contentRight: round(contentRight),
      reportsRight: (() => { const c = bar.querySelector(".wave-reports"); return c ? round(c.getBoundingClientRect().right) : null; })(),
      display: bcs.display,
      columns: bcs.gridTemplateColumns,
      cardScroll: (() => { const card = bar.closest("[data-init-card]"); return card ? { sw: card.scrollWidth, cw: card.clientWidth } : null; })(),
    };
  });
}`;

// ---- the sandbox -------------------------------------------------------------------------------------------------
const HOME = path.join(os.tmpdir(), `wag-row295-${process.pid}`);
console.log(`tree: ${ROOT}\nhome: ${HOME}${SHOTS ? `\nshots: ${SHOTS}` : ""}`);
const fixture = await buildFixture({ home: HOME });
const panel = await startFixturePanel({ home: HOME, root: ROOT });
await waitForFixtureRows(panel.base).catch(() => {});
const store = JSON.parse(readFileSync(path.join(HOME, "state", "initiatives.json"), "utf8"));
const storeById = new Map((store.initiatives || []).map((i) => [i.id, i]));
const WANT_ORDER = ["id", "owner", "status", "title", "project", "reports"];
const out = { tree: ROOT, home: HOME, frames: {} };

const openInitiatives = async (page) => {
  await page.waitForSelector("#btn-assistant", { timeout: 60_000 });
  const open = await page.evaluate(() => {
    const el = document.getElementById("assistant");
    return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
  });
  if (!open) await page.click("#btn-assistant");
  await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
  const selected = await page.evaluate(() => document.querySelector('#as-tabs [data-as-tab="initiatives"]')?.getAttribute("aria-selected") === "true");
  if (!selected) await page.click('#as-tabs [data-as-tab="initiatives"]');
  await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelectorAll("#as-initiatives .init-card").length >= 4, null, { timeout: 30_000 });
  await waitForInitiativesView(page).catch(() => {});
};

const setName = async (page, id, wantOpen) => {
  const head = page.locator(`#as-initiatives [data-init-card-toggle="${id}"]`);
  await head.waitFor({ state: "attached", timeout: 20_000 });
  for (let guard = 0; guard < 6; guard += 1) {
    const isOpen = (await head.getAttribute("aria-expanded")) === "true";
    if (isOpen === wantOpen) return true;
    await head.click();
    await sleep(220);
  }
  return (await head.getAttribute("aria-expanded")) === "true" ? wantOpen : !wantOpen;
};

// The string bodies are CALLED here rather than handed to page.evaluate as an argument-taking function: a string is
// evaluated as an expression, so a bare arrow function would answer the function itself and every read would be null.
const readName = (page, id) => page.evaluate(`(${NAME_JS})(${JSON.stringify(id)})`);
const readClamp = (page, id) => page.evaluate(`(${CLAMP_JS})(${JSON.stringify(id)})`);
const readBars = (page) => page.evaluate(`(${BARS_JS})()`);

const frame = async (page, label) => {
  console.log(`\n== ${label} ==`);
  await openPage(page, panel.base, { selector: "#btn-assistant" });
  await sleep(400);
  await openInitiatives(page);
  const result = { label, names: {}, clamps: {}, bars: null };

  // ---- 3. THE NAME: the same available width and the same breaks in both states -------------------------------
  for (const id of ["init_kafka", "init_release", "init_sso", "init_sweeper"]) {
    await setName(page, id, false);
    const closed = await readName(page, id);
    await setName(page, id, true);
    await page.waitForSelector(`[data-init-card="${id}"] .init-projects`, { timeout: 20_000 });
    const open = await readName(page, id);
    await sleep(120);
    const again = await readName(page, id);
    result.names[id] = { closed, open: again };
    if (!closed || !again) {
      ok(`${label}: the ${id} card is drawn in both states`, false, JSON.stringify({ closed: Boolean(closed), open: Boolean(again) }));
      continue;
    }
    note(
      `${id}: head closed ${closed.head.width}px / open ${again.head.width}px; available ${closed.avail}px / ${again.avail}px; ` +
        `lines closed ${JSON.stringify(closed.lines)} open ${JSON.stringify(again.lines)}`,
    );
    ok(
      `at ${label} the ${id} name's row is the folded row's own width`,
      Math.abs(again.head.width - closed.head.width) <= 0.5 && Math.abs(again.head.left - closed.head.left) <= 0.5,
      `${closed.head.width} -> ${again.head.width} at x ${closed.head.left} / ${again.head.left}`,
    );
    ok(
      `at ${label} the ${id} title is offered the same width open and closed`,
      Math.abs(again.avail - closed.avail) <= 0.5,
      `${closed.avail}px -> ${again.avail}px`,
    );
    ok(
      `at ${label} the ${id} title breaks at the same words open and closed`,
      JSON.stringify(again.lines) === JSON.stringify(closed.lines) && JSON.stringify(again.boxes.map((b) => b.w)) === JSON.stringify(closed.boxes.map((b) => b.w)),
      `closed ${JSON.stringify(closed.lines)} open ${JSON.stringify(again.lines)}`,
    );
    ok(
      `at ${label} the ${id} title's rect is where it was, at the same font`,
      Math.abs(again.title.left - closed.title.left) <= 0.5 && again.font === closed.font && again.lineHeight === closed.lineHeight && Math.abs(again.title.height - closed.title.height) <= 1,
      `x ${closed.title.left}->${again.title.left}, ${closed.font}/${closed.lineHeight} -> ${again.font}/${again.lineHeight}, h ${closed.title.height}->${again.title.height}`,
    );
    ok(
      `at ${label} the open ${id} name fills the row it is offered`,
      Math.abs(again.title.width - again.avail) <= 1 && Math.abs(again.title.right - (again.head.right - 18)) <= 1,
      `title ${again.title.width}px of ${again.avail}px offered, right edge ${again.title.right} vs row ${again.head.right} - 18`,
    );
    ok(
      `at ${label} the ${id} card gains no horizontal scrollbar in either state`,
      closed.scroll.sw <= closed.scroll.cw + 1 && again.scroll.sw <= again.scroll.cw + 1,
      `closed ${closed.scroll.sw}/${closed.scroll.cw}, open ${again.scroll.sw}/${again.scroll.cw}`,
    );
    if (label.includes("wide")) {
      // The wide drawing: the name's row is above both columns and reaches across them.
      const twoCols = again.columns.areas !== "none" && again.columns.desc && again.columns.side && again.columns.side.left > again.columns.desc.right;
      ok(
        `at ${label} the ${id} name's row sits above BOTH columns and reaches across them`,
        twoCols && again.head.left <= again.columns.desc.left + 1 && again.head.right >= again.columns.side.right - 1 && again.head.width > again.columns.desc.width + again.columns.side.width,
        `head ${again.head.left}..${again.head.right}, desc ${again.columns.desc.left}..${again.columns.desc.right}, side ${again.columns.side.left}..${again.columns.side.right}`,
      );
      ok(
        `at ${label} the ${id} description and projects stay side by side beneath the name`,
        twoCols && again.columns.areas.indexOf("head") < again.columns.areas.indexOf("desc"),
        `areas ${again.columns.areas}`,
      );
    }
  }

  // ---- 2. THE CLAMP -------------------------------------------------------------------------------------------
  for (const id of ["init_release", "init_kafka", "init_sweeper"]) {
    const description = String(storeById.get(id)?.description || "");
    const first = await readClamp(page, id);
    if (!first) {
      ok(`${label}: the ${id} description is drawn`, false);
      continue;
    }
    const tail = description.slice(-40);
    const findable = await page.evaluate((needle) => document.body.textContent.includes(needle), tail);
    result.clamps[id] = { clamped: first, description };
    const overflows = first.natural > first.height + 1;
    // A tree without the control at all (the base this change is measured against) reads as "not drawn", so the checks
    // below FAIL with their own sentences instead of throwing on a missing node.
    const more = first.more || { hidden: true, width: 0, label: "" };
    note(`${id}: folded ${first.clamped ? "clamped" : "whole"}, drawn ${first.height}px of ${first.natural}px needed, control ${JSON.stringify(more.label)} hidden=${more.hidden}`);
    ok(
      `at ${label} the ${id} description's whole text is in the DOM, and findable on the page`,
      first.text === description && findable,
      `${first.chars} chars in the body, store ${description.length}, last words findable ${findable}`,
    );
    if (!overflows) {
      // A SHORT DESCRIPTION GAINS NO CONTROL (the reader's own condition): it is drawn whole and the toggle stays out
      // of the layout, not merely greyed - a dead button is the thing the ask refuses.
      ok(
        `at ${label} the ${id} description fits its clamp, is drawn whole, and gains no control`,
        first.clamped === true && first.height === first.natural && more.hidden === true && more.width === 0,
        `${first.height}px drawn of ${first.natural}px needed, control hidden ${more.hidden} ${more.width}px wide`,
      );
      continue;
    }
    ok(
      `at ${label} the ${id} description is clamped to three line boxes`,
      first.lines === 3 && Math.abs(first.height - first.lineHeight * 3) <= 1,
      `${first.lines} lines, ${first.height}px of a ${first.lineHeight}px line`,
    );
    ok(
      `at ${label} the ${id} show more control is drawn because the text overflows the clamp`,
      more.hidden === false && more.width > 0 && more.label === "show more",
      `needs ${first.natural}px, clamp ${first.height}px, control ${JSON.stringify(more.label)} ${more.width}px`,
    );
    {
      // show more, then show less: the body, the words and the control's own record all move together.
      await page.click(`[data-init-card="${id}"] [data-init-desc-fold]`);
      await page.waitForFunction(
        (cardId) => document.querySelector(`[data-init-card="${cardId}"] [data-init-desc-more]`)?.getAttribute("aria-expanded") === "true",
        id,
        { timeout: 15_000 },
      );
      const whole = await readClamp(page, id);
      result.clamps[id].whole = whole;
      note(`${id}: show more -> ${whole.height}px drawn, control ${JSON.stringify(whole.more.label)} (${whole.more.width}px)`);
      ok(
        `at ${label} show more draws the whole ${id} description and says show less`,
        whole.clamped === false && whole.height > first.height + 1 && whole.more.label === "show less" && whole.text === description,
        `${whole.height}px of ${whole.natural}px, control ${JSON.stringify(whole.more.label)}`,
      );
      ok(`at ${label} the ${id} card is still open behind the control`, (await readName(page, id)).folded === false, "the card stays open");
      await page.click(`[data-init-card="${id}"] [data-init-desc-fold]`);
      await page.waitForFunction(
        (cardId) => document.querySelector(`[data-init-card="${cardId}"] [data-init-desc-more]`)?.getAttribute("aria-expanded") === "false",
        id,
        { timeout: 15_000 },
      );
      const back = await readClamp(page, id);
      result.clamps[id].back = back;
      ok(
        `at ${label} show less clamps the ${id} description back, with the whole text still in the DOM`,
        back.clamped === true && Math.abs(back.height - first.lineHeight * 3) <= 1 && back.more.label === "show more" && back.text === description,
        `${back.height}px, ${back.lines} lines, control ${JSON.stringify(back.more.label)}`,
      );
    }
  }

  // ---- 1. THE TASK BAR ----------------------------------------------------------------------------------------
  const bars = (await readBars(page)).filter((b) => b.id);
  result.bars = bars;
  note(`bars: ${bars.map((b) => `#${b.id} ${b.display} [${b.firstLine.join(" > ")}] ${b.width}/${b.stripWidth}px`).join(" | ")}`);
  ok(`at ${label} the wave lane draws its task bars`, bars.length >= 3, `${bars.length} bars`);
  ok(
    `at ${label} every bar reads #id, owner, status, name, project, reports in the DOM`,
    bars.length > 0 && bars.every((b) => JSON.stringify(b.order.filter((w) => w !== "reports-list")) === JSON.stringify(WANT_ORDER)),
    JSON.stringify(bars.map((b) => b.order.filter((w) => w !== "reports-list"))),
  );
  ok(
    `at ${label} every bar reads that way to the eye too - its first line, left to right`,
    bars.length > 0 && bars.every((b) => b.firstLine.slice(0, 4).join(",") === "id,owner,status,title"),
    JSON.stringify(bars.map((b) => b.firstLine)),
  );
  ok(
    `at ${label} the owner and status chips sit left of the name`,
    bars.length > 0 && bars.every((b) => {
      const at = (what) => b.kids.find((k) => k.what === what) || {};
      return at("owner").x > at("id").x && at("status").x > at("owner").right && at("title").x > at("status").x;
    }),
    JSON.stringify(bars.map((b) => b.kids.filter((k) => ["id", "owner", "status", "title"].includes(k.what)).map((k) => `${k.what}@${k.x}`))),
  );
  ok(
    `at ${label} the reports chip keeps the bar's right edge`,
    bars.length > 0 && bars.every((b) => b.reportsRight != null && Math.abs(b.reportsRight - b.contentRight) <= 1),
    JSON.stringify(bars.map((b) => ({ id: b.id, reports: b.reportsRight, content: b.contentRight }))),
  );
  ok(
    `at ${label} every task bar is still its section's width (row 291)`,
    bars.length > 0 && bars.every((b) => b.width >= b.stripWidth - 2),
    JSON.stringify(bars.map((b) => `${b.id}:${b.width}/${b.stripWidth}`)),
  );
  ok(
    `at ${label} no two items on one bar overlap`,
    bars.length > 0 && bars.every((b) => {
      for (let i = 0; i < b.kids.length; i += 1) {
        for (let j = i + 1; j < b.kids.length; j += 1) {
          const a = b.kids[i];
          const c = b.kids[j];
          const overlap = a.x < c.right && c.x < a.right && a.top < c.bottom && c.top < a.bottom;
          if (overlap) return false;
        }
      }
      return true;
    }),
    "2D rect intersection over every visible pair",
  );
  ok(
    `at ${label} the card that holds the lane gains no horizontal scrollbar`,
    bars.length > 0 && bars.every((b) => !b.cardScroll || b.cardScroll.sw <= b.cardScroll.cw + 1),
    JSON.stringify(bars.map((b) => (b.cardScroll ? `${b.id}:${b.cardScroll.sw}/${b.cardScroll.cw}` : `${b.id}:none`))),
  );
  if (SHOTS) {
    await page.evaluate(() => {
      const lane = document.querySelector("#as-initiatives .init-wavefold");
      const pane = document.getElementById("as-initiatives");
      if (lane && pane) pane.scrollTop += lane.getBoundingClientRect().top - pane.getBoundingClientRect().top - 8;
    });
    await sleep(150);
    const shot = path.join(SHOTS, `${label.replace(/[^a-z0-9]+/gi, "-")}.png`);
    await page.screenshot({ path: shot });
    note(`shot ${shot}`);
  }
  return result;
};

const post = async (route, body) => {
  const r = await fetch(`${panel.base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  await withBrowser(
    async ({ browser, page, withPage, pageErrors, consoleErrors }) => {
      // THE DOCKED RAIL: 480px, the panel's own default width for it. The width and the open pane are seeded before
      // any document loads - localStorage belongs to an origin, and the page has not been to one yet.
      const docked = await post("/api/settings/general", { dockMode: "docked" });
      ok("the panel is on the docked frame through its own route", docked.status === 200 && docked.body?.settings?.dockMode === "docked", JSON.stringify(docked.body?.settings?.dockMode ?? docked.body?.error));
      out.frames.dock = await frame(page, "dock 480");

      // THE WIDE FLOAT: 1400px of pane, past the tab's 1000px container query, so the two-column plate is the drawing.
      const floated = await post("/api/settings/general", { dockMode: "floating" });
      ok("the panel is on the floating frame through its own route", floated.status === 200 && floated.body?.settings?.dockMode === "floating", JSON.stringify(floated.body?.settings?.dockMode ?? floated.body?.error));
      const wide = await withPage(async ({ page: widePage }) => {
        await sleep(200);
        return frame(widePage, "wide float 1400");
      }, {
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: 1,
        initScripts: [
          () => {
            localStorage.setItem("wm.assistantOpen", "1");
            localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 8, y: 80, w: 1400, h: 880 }));
          },
        ],
      });
      out.frames.wide = wide;

      const pane = await page.evaluate(() => {
        const el = document.getElementById("assistant");
        const r = el.getBoundingClientRect();
        return { width: Math.round(r.width), floating: el.classList.contains("is-floating") };
      });
      note(`the docked pane measured ${pane.width}px`);
      await post("/api/settings/general", { dockMode: "docked" });

      out.pageErrors = pageErrors.slice();
      out.consoleErrors = consoleErrors.slice();
      ok("no page errors and no console errors", pageErrors.length === 0 && consoleErrors.length === 0, `${pageErrors.length} page, ${consoleErrors.length} console`);
      return failures;
    },
    {
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 1,
      initScripts: [
        () => {
          localStorage.setItem("wm.assistantOpen", "1");
          localStorage.setItem("wm.assistantWidth", "480");
        },
      ],
    },
  );
} catch (err) {
  failures += 1;
  console.error(`\nFAIL  the run threw: ${err && err.stack ? err.stack : err}`);
  try {
    console.error(panel.log().split("\n").slice(-20).join("\n"));
  } catch {
    /* the log is a courtesy */
  }
} finally {
  await panel.stop().catch(() => {});
  clearTimeout(watchdog);
}

if (JSON_OUT) {
  writeFileSync(path.resolve(JSON_OUT), `${JSON.stringify(out, null, 2)}\n`, "utf8");
  note(`json ${path.resolve(JSON_OUT)}`);
}
console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed${SHOTS ? `; shots in ${SHOTS}` : ""}`);
process.exit(failures === 0 ? 0 : 1);
