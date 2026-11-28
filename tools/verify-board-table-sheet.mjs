#!/usr/bin/env node
// HARNESS: LIVE GATE - npm run verify:board-table-sheet proves the board-table move.
//
// WHAT THIS GUARDS. public/board-table.css took the board table's rules out of chart.css, rows.css,
// rowstrips.css, boardchips.css and overlays.css, and chart.css kept the age column and the legend.
// A stylesheet move is defined by what the browser computes, not by what the text says.
//
// ONE BOOT, ONE DOM, TWO SHEET SETS. Two boots of the same fixture do not render the same document -
// the panel's scan keeps adding and dropping chips, and the same tree measured twice came back 13
// elements apart - so comparing a second boot proves nothing. This harness instead boots the page
// ONCE from this tree, then loads the pre-move sheets (a `git archive` export of --old) as a second,
// initially disabled set of <link>s that sit at the SAME place in <head>, and toggles between the two
// sets on the live document: `link.disabled` changes the cascade and nothing else. The DOM is the
// same element for element on both sides, so a difference is a style difference.
//
// THE SEQUENCE IS A, B, A. The old set is measured, the new set is measured, and the old set is
// measured again; if the two old readings disagree the document moved under the harness and the run
// fails rather than claiming anything.
//
// For every element it records its border box and a hash of its computed style; every element under
// #projects (the surface that moved) also carries the full sorted style map, so a difference names
// the property and not only the element. Time-driven values are dropped (animation-*, transition-*,
// stroke-dashoffset - a countdown ring moves every second without any style change), and the map is
// sorted because Chromium enumerates custom properties in an unstable order. The ::before/::after
// boxes are measured where they have content.
//
//   node tools/verify-board-table-sheet.mjs                  # both widths, captures under docs/reports/board-table-sheet
//   node tools/verify-board-table-sheet.mjs --old <rev>      # another pre-move revision
//   node tools/verify-board-table-sheet.mjs --out <dir>      # another capture directory
//   node tools/verify-board-table-sheet.mjs --keep           # keep the export
//
// Exit: 0 pass; 1 a check failed; 2 Playwright is missing and the measurement could not run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT = path.resolve(opt("--out", path.join(ROOT, "docs", "reports", "board-table-sheet")));
const OLD = opt("--old", "HEAD");
const KEEP = has("--keep");
const WIDTHS = [
  { width: 1160, height: 1200, label: "1160" },
  { width: 420, height: 1000, label: "420" },
];
const FIXED_CLOCK = Date.UTC(2026, 10, 25, 12, 0, 0);
const BOTH = "http://wag.test"; // the route prefix the old sheets are served under

let failures = 0;
const line = (s = "") => console.log(s);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const fwd = (p) => String(p).split(path.sep).join("/");

async function main() {
  const { seedFixture } = await import("./verify-css-split.mjs");
  const { startFixturePanel } = await import("./initiatives-fixture.mjs");
  const { withBrowser, openPage } = await import("./browser.mjs");

  mkdirSync(OUT, { recursive: true });
  const work = path.join(os.tmpdir(), "wag", "board-table-sheet");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  line(`exporting ${OLD}`);
  const oldRoot = path.join(work, "old");
  exportRoot(OLD, oldRoot, work);
  const oldOrder = sheetHrefs(readFileSync(path.join(oldRoot, "public", "index.html"), "utf8"));
  line(`  the pre-move page loaded ${oldOrder.length} sheets`);

  const home = path.join(work, "fixture");
  seedFixture(home);
  const panel = await startFixturePanel({ home, root: ROOT });
  let result;
  try {
    result = await withBrowser(
      async ({ page }) => {
        // Every old sheet is served from the export under the same file name.
        await page.route(`${BOTH}/**`, async (route) => {
          const name = new global.URL(route.request().url()).pathname.replace(/^\//, "");
          const file = path.join(oldRoot, "public", name);
          if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
          return route.fulfill({ status: 200, contentType: "text/css", body: readFileSync(file, "utf8") });
        });
        await page.addInitScript((fixed) => {
          const Real = Date;
          class Fixed extends Real {
            constructor(...args) {
              if (args.length === 0) super(fixed);
              else super(...args);
            }
            static now() {
              return fixed;
            }
          }
          // eslint-disable-next-line no-global-assign
          Date = Fixed;
          // Every interval the page arms is recorded so the harness can stop them: the board keeps
          // adding and dropping chips as its scan runs, and a document that moves between two
          // readings proves nothing.
          window.__wagIntervals = [];
          const realSetInterval = window.setInterval;
          window.setInterval = function (...args) {
            const id = realSetInterval.apply(window, args);
            window.__wagIntervals.push(id);
            return id;
          };
          try {
            localStorage.setItem("wtgui.think", "1");
          } catch {
            /* no storage still measures everything else */
          }
        }, FIXED_CLOCK);
        await openPage(page, panel.base, { selector: "#projects", timeout: 60_000 });
        await settleBoard(page);
        // Freeze the document: stop the stream and every interval, then prove the element count holds.
        await page.evaluate(() => {
          try {
            state.es.close();
          } catch {
            /* no stream still measures everything else */
          }
          for (const id of window.__wagIntervals || []) clearInterval(id);
          window.__wagIntervals = [];
        });
        const frozen = await page.evaluate(async () => {
          const count = () => document.querySelectorAll("body, body *").length;
          const seen = [];
          for (let i = 0; i < 4; i += 1) {
            seen.push(count());
            await new Promise((r) => setTimeout(r, 400));
          }
          return seen;
        });
        line(`  frozen document: ${frozen.join(" ")} elements`);
        if (frozen.some((n) => n !== frozen[0])) throw new Error(`the document did not freeze: ${frozen.join(", ")}`);
        // The old sheet set, in the pre-move page's order, inserted where the per-surface sheets sit
        // (before the core/ cards): disabled until a reading asks for it.
        // <style> rather than <link>: a disabled link fetches late (or not at all), so the first
        // reading could race the load. The text is fetched here and the style element's own sheet is
        // disabled, which is synchronous.
        const inserted = await page.evaluate(
          async ({ order, prefix }) => {
            const head = document.querySelector("head");
            const anchor = [...head.querySelectorAll('link[rel="stylesheet"]')].find((l) => /\/core\//.test(l.getAttribute("href") || ""));
            const made = [];
            for (const href of order) {
              const res = await fetch(`${prefix}/${href}`);
              if (!res.ok) throw new Error(`old sheet ${href}: ${res.status}`);
              const style = document.createElement("style");
              style.setAttribute("data-old-sheet", href);
              style.textContent = await res.text();
              if (style.sheet) style.sheet.disabled = true;
              head.insertBefore(style, anchor || null);
              made.push(href);
            }
            return made;
          },
          { order: oldOrder, prefix: BOTH },
        );
        const out = [];
        for (const w of WIDTHS) {
          await page.setViewportSize({ width: w.width, height: w.height });
          await page.waitForTimeout(500);
          const readings = [];
          // A warm-up toggle first: the first reading after a stylesheet swap lands mid-reflow (fonts
          // and the scrollbar settle on the next frame), and a warm reading is what the pair matches.
          for (const warm of ["new", "old"]) {
            await page.evaluate((m) => {
              for (const node of document.querySelectorAll('link[rel="stylesheet"], style[data-old-sheet]')) {
                const isOld = node.hasAttribute("data-old-sheet");
                const off = m === "old" ? !isOld : isOld;
                if (node.sheet) node.sheet.disabled = off;
                else node.disabled = off;
              }
              document.body.getBoundingClientRect();
            }, warm);
            await page.waitForTimeout(700);
            await page.evaluate(MEASURE_JS);
          }
          for (const mode of ["old", "new", "old"]) {
            await page.evaluate((m) => {
              for (const node of document.querySelectorAll('link[rel="stylesheet"], style[data-old-sheet]')) {
                const isOld = node.hasAttribute("data-old-sheet");
                const off = m === "old" ? !isOld : isOld;
                if (node.sheet) node.sheet.disabled = off;
                else node.disabled = off;
              }
              document.body.getBoundingClientRect();
            }, mode);
            // A capture below scrolls the page, and a scroll is not a style: every reading starts from
            // the same scroll position.
            await page.evaluate(() => {
              window.scrollTo(0, 0);
              for (const el of document.querySelectorAll("main, .wt-scroll, #projects")) {
                el.scrollTop = 0;
                el.scrollLeft = 0;
              }
            });
            await page.waitForTimeout(700);
            const got = await page.evaluate(MEASURE_JS);
            if (mode !== "new" || true) {
              // A capture per side, at the same scroll position.
              await page.evaluate(() => document.querySelector("#projects").scrollIntoView({ block: "start", inline: "start" }));
              await page.waitForTimeout(150);
              const geom = await page.evaluate(() => {
                const r = document.querySelector("#projects").getBoundingClientRect();
                const bar = document.querySelector(".topbar");
                return { x: r.x, y: r.y, w: r.width, h: r.height, barBottom: bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0 };
              });
              const vp = page.viewportSize();
              const x = Math.max(0, Math.min(Math.floor(geom.x), vp.width - 1));
              const y = Math.max(0, Math.min(Math.max(Math.floor(geom.y) - 8, geom.barBottom), vp.height - 1));
              const suffix = readings.length === 0 ? "before" : readings.length === 1 ? "after" : "again";
              await page.screenshot({
                path: path.join(OUT, `${suffix}-${w.label}.png`),
                clip: {
                  x,
                  y,
                  width: Math.max(1, Math.min(Math.ceil(geom.w), vp.width - x)),
                  height: Math.max(1, Math.min(Math.ceil(geom.h), vp.height - y)),
                },
              });
            }
            readings.push({ mode, elements: got.elements, pseudos: got.pseudos, rows: got.rows, digest: sha(JSON.stringify(got.rows)) });
          }
          out.push({ width: w.label, old: readings[0], now: readings[1], again: readings[2] });
        }
        return { inserted, out };
      },
      { viewport: { width: WIDTHS[0].width, height: WIDTHS[0].height }, deviceScaleFactor: 1 },
    );
  } finally {
    await panel.stop();
  }

  line(`  old sheet links inserted: ${result.inserted.length}`);
  for (const w of result.out) {
    const settled = w.old.digest === w.again.digest;
    line("");
    line(`AT ${w.width} PX`);
    line(`  elements   old ${w.old.elements}   new ${w.now.elements}   old again ${w.again.elements}`);
    line(`  pseudos    old ${w.old.pseudos}   new ${w.now.pseudos}`);
    line(`  digest     old   ${w.old.digest.slice(0, 16)}`);
    line(`             again ${w.again.digest.slice(0, 16)}  ${settled ? "(repeatable)" : "(DOES NOT REPEAT)"}`);
    line(`             new   ${w.now.digest.slice(0, 16)}`);
    if (!settled) {
      failures += 1;
      line("  FAIL  the old sheet set does not measure the same twice - the document moved under the harness");
      for (const d of compareElements(w.old.rows, w.again.rows).slice(0, 8)) line(`    ${d}`);
      continue;
    }
    const diffs = compareElements(w.old.rows, w.now.rows);
    if (diffs.length) {
      failures += 1;
      line(`  FAIL  ${diffs.length} element(s) differ`);
      for (const d of diffs.slice(0, 16)) line(`    ${d}`);
    } else if (w.old.digest !== w.now.digest) {
      failures += 1;
      line("  FAIL  the element rows agree one by one but the digest differs - a measurement leak");
    } else {
      line(`  PASS  every element and every pseudo box computes the same style with ${OLD}'s sheets and with this tree's`);
    }
    writeFileSync(path.join(OUT, `old-${w.width}.json`), JSON.stringify({ width: w.width, elements: w.old.elements, digest: w.old.digest, rows: w.old.rows }, null, 1));
    writeFileSync(path.join(OUT, `new-${w.width}.json`), JSON.stringify({ width: w.width, elements: w.now.elements, digest: w.now.digest, rows: w.now.rows }, null, 1));
  }

  line("");
  if (!KEEP) rmSync(work, { recursive: true, force: true });
  line(failures ? `FAIL  ${failures} check(s)` : "PASS  the board table computes the same under both sheet sets");
  if (failures) process.exitCode = 1;
}

function exportRoot(rev, dir, work) {
  mkdirSync(dir, { recursive: true });
  const tar = path.join(work, "tree.tar");
  execFileSync("git", ["-C", ROOT, "archive", "--format=tar", "-o", tar, rev], { stdio: "pipe" });
  execFileSync("tar", ["--force-local", "-xf", fwd(tar), "-C", fwd(dir)], { stdio: "pipe" });
  if (!existsSync(path.join(dir, "public", "index.html"))) throw new Error(`export of ${rev} has no public/index.html`);
}

export function sheetHrefs(html) {
  return [...html.matchAll(/<link\s+rel="stylesheet"\s+href="\/([^"]+\.css)"/g)].map((m) => m[1]);
}

async function settleBoard(page) {
  await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.rows.size > 0, null, { timeout: 90_000 });
  await page.waitForFunction(() => [...state.rows.values()].length >= 4, null, { timeout: 90_000 });
  await page.evaluate(() => {
    for (const r of state.rows.values()) {
      state.expandedProjects.add(r.project);
      state.expanded.add(`${r.project}::${r.path}`);
    }
    renderAll();
  });
  const signature = () =>
    page.evaluate(() => {
      const root = document.querySelector("#projects");
      return root ? `${root.innerText}\u0000${root.querySelectorAll("*").length}` : "";
    });
  let last = null;
  let same = 0;
  for (let i = 0; i < 40 && same < 6; i += 1) {
    const text = await signature();
    const settled = text.length > 0 && !text.includes("\u2026");
    if (settled && text === last) same += 1;
    else same = 0;
    last = text;
    if (same < 6) await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1200);
}

// Every element in the document, in DOM order, with its box and its computed style.
const MEASURE_JS = () => {
  const SKIP = /^(animation|transition)|^stroke-dashoffset$/;
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const label = (el) => {
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls}`;
  };
  const styleOf = (el, pseudo) => {
    const cs = getComputedStyle(el, pseudo || null);
    const map = {};
    for (let i = 0; i < cs.length; i += 1) {
      const p = cs[i];
      if (SKIP.test(p)) continue;
      map[p] = cs.getPropertyValue(p);
    }
    const keys = Object.keys(map).sort();
    const sorted = {};
    for (const k of keys) sorted[k] = map[k];
    return sorted;
  };
  const flat = (map) => Object.keys(map).map((k) => `${k}:${map[k]}`).join(";");
  // Document coordinates, not viewport ones: a capture scrolls the page, and a scroll is not a style.
  const rectOf = (r) => [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100);
  const board = document.querySelector("#projects");
  const rows = [];
  let pseudos = 0;
  for (const el of document.querySelectorAll("body, body *")) {
    if (el.hasAttribute("data-old-sheet")) continue;
    const row = { label: label(el), rect: rectOf(el.getBoundingClientRect()) };
    const style = styleOf(el);
    row.h = fnv(flat(style));
    if (board && board.contains(el)) row.style = style;
    for (const pseudo of ["before", "after"]) {
      const cs = getComputedStyle(el, `::${pseudo}`);
      if (!cs || !cs.content || cs.content === "none" || cs.content === "normal") continue;
      row[pseudo] = fnv(flat(styleOf(el, `::${pseudo}`)));
      pseudos += 1;
    }
    rows.push(row);
  }
  return { elements: rows.length, pseudos, rows };
};

function compareElements(a, b) {
  const out = [];
  if (a.length !== b.length) out.push(`element count ${a.length} vs ${b.length}`);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.label !== y.label) {
      out.push(`#${i} ${x.label} vs ${y.label}`);
      continue;
    }
    if (JSON.stringify(x.rect) !== JSON.stringify(y.rect)) out.push(`#${i} ${x.label} box ${JSON.stringify(x.rect)} vs ${JSON.stringify(y.rect)}`);
    if (x.h !== y.h) {
      const sx = x.style || {};
      const sy = y.style || {};
      let detail = "";
      for (const k of new Set([...Object.keys(sx), ...Object.keys(sy)])) {
        if (sx[k] !== sy[k]) {
          detail = ` ${k}: ${sx[k]} vs ${sy[k]}`;
          break;
        }
      }
      out.push(`#${i} ${x.label} style hash${detail}`);
    }
    for (const pseudo of ["before", "after"]) {
      if (x[pseudo] !== y[pseudo]) out.push(`#${i} ${x.label} ::${pseudo} ${x[pseudo] || "(none)"} vs ${y[pseudo] || "(none)"}`);
    }
  }
  return out;
}

main().catch((err) => {
  console.error(`FAIL  ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
