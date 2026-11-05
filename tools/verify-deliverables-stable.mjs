// The DELIVERABLES control is a STABLE, TRUTHFUL button — proved by driving a real panel.
//
//   node tools/verify-deliverables-stable.mjs
//
// HARNESS: LIVE GATE — it tracks main, and `npm run verify:deliverables-stable` is how the repo runs it by name.
//
// WHAT THIS IS. Two defects were measured on the live panel (2026-11-05, headless Chromium, 1440 px wide) and this
// gate pins the fix for both. The popup itself is NOT in scope: it opens, lists 200 rows and closes, and
// tools/verify-deliverables-ui.mjs already drives that.
//
// 1. THE BUTTON WAS A MOVING TARGET. `#stream-rate` is written by a 1 s clock (`public/app.js`, the `stream-rate`
//    interval). Its text grows a character as the event count passes a power of ten ("97 events" -> "111 events"),
//    and the whole `.controls` row grows with it: measured 980 -> 986.59 px, which moved `#btn-deliver`'s left edge
//    654.25 -> 660.84. The first time the pool clause arrives the line grows by a whole clause and the button moved
//    588.28 -> 660.84 (72.56 px). A control that moves under the reader's cursor is not a control.
//    The gate samples the button's rect across at least four REAL ticks of that clock, and then across a
//    deliberately short and a deliberately long status line, and fails on ANY movement of x, y, width or height.
//
// 2. THE BADGE WAS A DEAD 0x0 SPAN. `#deliver-badge` shipped in the markup with "0" in it and `hidden` set; the
//    page only ever toggled `hidden`, so the node stayed in the button with `textContent` "0" — the button read
//    "DELIVERABLES0" to anything that reads text, and the span measured 0x0 at (0,0). The contract this gate pins:
//    with nothing unseen there is NO badge node at all and the button's text is exactly "DELIVERABLES"; a row above
//    the reader's watermark creates the pill with real geometry, inside the button's own box, carrying the count;
//    and marking it seen removes the node again (never leaves a hidden zero behind).
//
// HOW TO SEE IT FAIL. Run it on the tree before this commit (or `git stash` the style.css / app.js / index.html
// half): the text-length probe moves the button and both zero-state badge checks find the dead span.
//
// The browser half needs a Playwright install; without one this exits 2 (BROWSER-HALF-NOT-RUN), like the other
// verify-*.mjs harnesses.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, openPage } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";
import { Deliverables } from "../lib/deliverables.js";

const SHOT_DIR = process.env.PANEL_SHOT_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".shots");

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

// ---- the sandbox: one real deliverable, so the badge has a real job to do ------------------------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-stable-"));
const tree = path.join(dir, "repos", "agent-worktree-gui", ".worktrees", "wtgui-stable-badge");
mkdirSync(path.join(tree, "docs"), { recursive: true });
mkdirSync(path.join(dir, "logs"), { recursive: true });
writeFileSync(path.join(tree, "docs", "one.md"), "# the one deliverable\n");
const store = new Deliverables({ file: path.join(dir, "logs", "deliverables.json"), log: () => {} });
store.record({
  job: { id: "stable01", thread: "wtgui-stable-badge", turn: 1, project: "agent-worktree-gui", worktreePath: tree, branch: "wtgui/stable-badge" },
  tree: { path: tree, branch: "wtgui/stable-badge" },
  finalText: "DELIVER file docs/one.md | The one deliverable",
  agent: "stable-badge",
  now: Date.now(),
});
console.log(`      seeded  ${store.size} row in ${path.join(dir, "logs", "deliverables.json")}`);

const panel = await startPanel({ dir, keep: true, config: { assistant: { enabled: false } } });
console.log(`      panel   ${panel.base}  (throwaway: ${panel.dir})`);

try {
  const result = await withBrowser(async ({ page }) => {
    await openPage(page, panel.base, { selector: "#btn-deliver" });
    await page.evaluate(() => document.fonts?.ready);

    // ---- 1. the badge with something unseen: real geometry, a real count, inside the button --------------------
    await page.waitForFunction(() => Boolean(document.getElementById("deliver-badge")), null, { timeout: 10_000 });
    const live = await page.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; };
      const btn = document.getElementById("btn-deliver");
      const pill = document.getElementById("deliver-badge");
      const b = rect(btn);
      const p = rect(pill);
      return {
        text: (pill.textContent || "").trim(),
        rect: p,
        inside: p.x >= b.x && p.x + p.w <= b.x + b.w + 0.5 && p.y >= b.y && p.y + p.h <= b.y + b.h + 0.5,
        label: btn.getAttribute("aria-label") || "",
        cls: btn.classList.contains("has-unseen"),
      };
    });
    ok("an unseen row puts a badge in the button", Boolean(live.rect), JSON.stringify(live.rect));
    ok("…with real geometry, not a 0x0 span at the origin", live.rect.w > 0 && live.rect.h > 0 && live.rect.x > 0 && live.rect.y > 0, JSON.stringify(live.rect));
    ok("…inside the button's own box", live.inside, JSON.stringify(live.rect));
    eq("…carrying the count", live.text, "1");
    ok("…and the button wears the highlight", live.cls);
    ok("…with the number in the aria-label too", /1 new deliverable/.test(live.label), live.label);
    mkdirSync(SHOT_DIR, { recursive: true });
    const badgeShot = path.join(SHOT_DIR, "deliverables-stable-badge.png");
    await page.screenshot({ path: badgeShot, clip: { x: 0, y: 0, width: 1440, height: 110 } });
    console.log(`SHOT  ${badgeShot}`);

    // ---- 2. marking it seen REMOVES the node: no hidden zero is left inside the button -------------------------
    await page.click("#deliver-badge");
    await page.waitForFunction(() => !document.getElementById("deliver-badge"), null, { timeout: 5_000 }).catch(() => {});
    const cleared = await page.evaluate(() => {
      const btn = document.getElementById("btn-deliver");
      const pill = document.getElementById("deliver-badge");
      return { present: Boolean(pill), text: btn.textContent.trim(), label: btn.getAttribute("aria-label") || "", cls: btn.classList.contains("has-unseen") };
    });
    ok("marking seen removes the badge node (never a hidden 0x0 span)", cleared.present === false);
    eq("…so the button's own text is exactly DELIVERABLES", cleared.text, "DELIVERABLES");
    ok("…and the highlight goes with it", cleared.cls === false);

    // ---- 3. the clock ticks, and the button does not move ------------------------------------------------------
    const ticks = await page.evaluate(async () => {
      const btn = document.getElementById("btn-deliver");
      const rate = document.getElementById("stream-rate");
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; };
      const out = [];
      await new Promise((resolve) => {
        const obs = new MutationObserver(() => {
          out.push({ n: out.length + 1, rect: rect(btn), rate: (rate.textContent || "").trim(), rateW: +rate.getBoundingClientRect().width.toFixed(2) });
          if (out.length >= 4) { obs.disconnect(); resolve(); }
        });
        obs.observe(rate, { childList: true, characterData: true, subtree: true });
        setTimeout(() => { obs.disconnect(); resolve(); }, 10_000);
      });
      return out;
    });
    ok("the 1 s status clock really ticked (>= 4 repaints observed)", ticks.length >= 4, `${ticks.length} tick(s)`);
    const moves = ticks.filter((t) => !same(t.rect, ticks[0].rect));
    ok("the button did not move across those ticks", ticks.length >= 4 && moves.length === 0, moves.length ? JSON.stringify(moves) : `${ticks[0]?.rect.x},${ticks[0]?.rect.y} held for ${ticks.length} ticks`);

    // ---- 4. the layout contract: a longer status line cannot move it -------------------------------------------
    // The clock's own text may not change length during a quiet minute, so the same span is driven to a short and a
    // deliberately long line. This is the deterministic half: it is the element that repaints on the timer, and its
    // content must never reach the action group's position.
    const probe = await page.evaluate(async () => {
      const btn = document.getElementById("btn-deliver");
      const rate = document.getElementById("stream-rate");
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; };
      const paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const before = rate.textContent;
      rate.textContent = "12 events · 1.2/s";
      await paint();
      const short = rect(btn);
      rate.textContent = "pool 5/5 · 34 conversations · 4 running · 12345 events · 11.5/s";
      await paint();
      const long = rect(btn);
      rate.textContent = before;
      await paint();
      const restored = rect(btn);
      return { short, long, restored };
    });
    ok("a short status line and a long one put the button in the same place", same(probe.short, probe.long), `${JSON.stringify(probe.short)} vs ${JSON.stringify(probe.long)}`);
    ok("…and putting the line back leaves it there too", same(probe.short, probe.restored), JSON.stringify(probe.restored));

    // ---- 5. a page that has never seen anything carries no badge at all ---------------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-deliver", { timeout: 15_000 });
    await page.waitForFunction(() => (document.getElementById("stream-rate")?.textContent || "").trim().length > 0, null, { timeout: 15_000 }).catch(() => {});
    const zero = await page.evaluate(() => {
      const btn = document.getElementById("btn-deliver");
      return { present: Boolean(document.getElementById("deliver-badge")), text: btn.textContent.trim(), html: btn.innerHTML.replace(/\s+/g, " ").trim() };
    });
    ok("a page with nothing unseen has NO badge node in the button", zero.present === false, zero.html);
    eq("…so the control reads DELIVERABLES, never DELIVERABLES0", zero.text, "DELIVERABLES");
    const zeroShot = path.join(SHOT_DIR, "deliverables-stable-zero.png");
    await page.screenshot({ path: zeroShot, clip: { x: 0, y: 0, width: 1440, height: 110 } });
    console.log(`SHOT  ${zeroShot}`);

    return failures;
  }, { viewport: { width: 1440, height: 900 } });

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (result !== failures) console.log("note: the browser callback's own failure count disagreed with the module counter");
} catch (e) {
  failures += 1;
  console.log(`FAIL  the gate threw: ${e && e.stack ? e.stack : e}`);
} finally {
  await panel.stop?.();
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
