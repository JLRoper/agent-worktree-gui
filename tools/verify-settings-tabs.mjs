#!/usr/bin/env node
// Settings is a TAB STRIP: one tab per group, one panel on screen, the reader's tab remembered — and a search that
// stays global across every tab.
//
//   node tools/verify-settings-tabs.mjs
//
// WHAT WAS WRONG. The seven groups were seven folding accordions: every group started folded, its heading was the
// fold control, `wtgui.settingsUnfolded` remembered which ones were open, and the group divider plus the caret rules
// in style.css carried the shape. The panel was therefore a tall list the reader had to unfold piece by piece, and
// two groups could never be compared without scrolling.
//
// WHAT IS DRIVEN, on a sandbox panel of this checkout in a real Chromium:
//   * eleven tabs, one per `data-settings-group` key, in the markup's own order, with role=tablist/tab/tabpanel,
//     aria-controls/aria-labelledby, exactly one aria-selected, one roving tabindex=0 and exactly one panel drawn
//   * a press selects a tab and shows only its panel, and remembers it under wtgui.settingsTab
//   * ArrowLeft/ArrowRight (wrapping), Home/End move AND select, Enter/Space select, and the focus follows
//   * the chosen tab is the one painted after a reload, before the panel is even opened
//   * the search is GLOBAL: a query that only matches a row on another tab reveals that tab, each tab carries its
//     own match count, the counts add up to the visible rows, the search never writes the reader's tab, and Esc
//     clears back to it
//   * #219 still holds: the head drags the window and the search box does not, the corner grip is 18x18 and
//     resizes, wtgui.settingsRect survives a reload, and Esc / ✕ / an outside press all close it
//
// RED PROOF. Run this file in a `git archive origin/main | tar -x` export of 0.63.0 and it fails on the first
// check — there is no [data-settings-tab] there — so a green run here means the tab strip is what answered, not
// an empty page. It prints BROWSER-HALF-NOT-RUN and exits 2 when Playwright is absent, rather than passing a half
// that never ran.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const WIDE = { width: 1400, height: 900 };
const TAB_KEY = "wtgui.settingsTab";
const RECT_KEY = "wtgui.settingsRect";
const KEYS = ["display", "cards", "board", "repo", "data", "gateway", "skills", "updates", "permissions", "pipeline", "bundles"];
const LABELS = ["Display", "Cards", "Board", "Repo", "Data", "Gateway", "Skills", "Updates", "Permissions", "Pipeline", "Bundles"];
const MIN = { w: 320, h: 240 };
const EDGE = 8;

let failures = 0;
let checks = 0;
const check = (cond, label, detail = "") => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const note = (text) => console.log(`      ${text}`);
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
const rectText = (r) => (r ? `${r.left},${r.top} ${r.width}x${r.height}` : "none");

// One read of everything this gate has an opinion about, so every case is a statement about the same numbers.
const read = (page) =>
  page.evaluate((key) => {
    const panel = document.getElementById("settings");
    const strip = document.getElementById("settings-tabs");
    const tabs = [...document.querySelectorAll("#settings [role='tab']")];
    const panels = [...document.querySelectorAll("#settings .settings-group")];
    const badge = (t) => t.querySelector(".settings-tab-count");
    const box = panel ? panel.getBoundingClientRect() : null;
    const grip = document.getElementById("settings-grip");
    const g = grip ? grip.getBoundingClientRect() : null;
    return {
      open: Boolean(panel) && !panel.classList.contains("hidden"),
      stripRole: strip ? strip.getAttribute("role") : null,
      tabCount: tabs.length,
      panelCount: panels.length,
      tabKeys: tabs.map((t) => t.dataset.settingsTab),
      labels: tabs.map((t) => t.querySelector(".settings-tab-label")?.textContent || ""),
      roles: tabs.map((t) => t.getAttribute("role")),
      selected: tabs.map((t) => t.getAttribute("aria-selected")),
      tabindex: tabs.map((t) => t.getAttribute("tabindex")),
      controls: tabs.map((t) => t.getAttribute("aria-controls")),
      panelKeys: panels.map((p) => p.dataset.settingsGroup),
      panelRoles: panels.map((p) => p.getAttribute("role")),
      panelLabelled: panels.map((p) => p.getAttribute("aria-labelledby")),
      shown: panels.filter((p) => p.getClientRects().length > 0).map((p) => p.dataset.settingsGroup),
      unhidden: panels.filter((p) => !p.hidden).map((p) => p.dataset.settingsGroup),
      counts: Object.fromEntries(tabs.map((t) => [t.dataset.settingsTab, (badge(t)?.textContent || "").trim()])),
      badgesShown: Object.fromEntries(tabs.map((t) => [t.dataset.settingsTab, Boolean(badge(t)) && !badge(t).hidden])),
      ariaLabels: Object.fromEntries(tabs.map((t) => [t.dataset.settingsTab, t.getAttribute("aria-label")])),
      rows: panels.reduce((n, p) => n + p.querySelectorAll(".settings-row").length, 0),
      rowCounts: Object.fromEntries(panels.map((p) => [p.dataset.settingsGroup, p.querySelectorAll(".settings-row").length])),
      visibleRows: Object.fromEntries(panels.map((p) => [p.dataset.settingsGroup, [...p.querySelectorAll(".settings-row")].filter((r) => r.getClientRects().length > 0).length])),
      stored: localStorage.getItem(key),
      query: document.getElementById("settings-search")?.value || "",
      focus: document.activeElement?.id || "",
      focusTab: document.activeElement?.dataset?.settingsTab || "",
      rect: box ? { left: +box.left.toFixed(1), top: +box.top.toFixed(1), width: +box.width.toFixed(1), height: +box.height.toFixed(1), right: +box.right.toFixed(1), bottom: +box.bottom.toFixed(1) } : null,
      grip: g ? { width: +g.width.toFixed(1), height: +g.height.toFixed(1), cursor: grip ? getComputedStyle(grip).cursor : "" } : null,
      inlineLeft: panel ? panel.style.left : "",
      storedRect: localStorage.getItem("wtgui.settingsRect"),
      // The strip's own size numbers. The labels were 9.5px in a 3px 3px 4px box: readable only if you lean in,
      // and a 20px click target. These are read on every snapshot so the size cases below are statements about
      // the same pixels the interaction cases just pressed.
      tabStyle: (() => {
        if (!tabs.length || !strip) return null;
        const cs = getComputedStyle(tabs[0]);
        const badgeEl = badge(tabs[0]);
        const sr = strip.getBoundingClientRect();
        const boxes = tabs.map((t) => {
          const r = t.getBoundingClientRect();
          return {
            key: t.dataset.settingsTab,
            text: t.querySelector(".settings-tab-label")?.textContent || "",
            left: +r.left.toFixed(2),
            top: +r.top.toFixed(2),
            width: +r.width.toFixed(2),
            height: +r.height.toFixed(2),
            right: +r.right.toFixed(2),
            scrollWidth: t.scrollWidth,
            clientWidth: t.clientWidth,
            drawn: t.getClientRects().length > 0,
          };
        });
        return {
          font: parseFloat(cs.fontSize),
          fontRaw: cs.fontSize,
          height: +boxes[0].height.toFixed(2),
          padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" "),
          letterSpacing: cs.letterSpacing,
          textTransform: cs.textTransform,
          badgeFont: badgeEl ? parseFloat(getComputedStyle(badgeEl).fontSize) : null,
          stripWidth: +sr.width.toFixed(2),
          stripHeight: +sr.height.toFixed(2),
          stripScrollsX: strip.scrollWidth > strip.clientWidth + 1,
          rows: new Set(boxes.map((b) => Math.round(b.top))).size,
          boxes,
          clipped: boxes.filter((b) => !b.drawn || b.width < 1 || b.right > sr.right + 0.5 || b.scrollWidth > b.clientWidth + 1).map((b) => b.key),
        };
      })(),
    };
  }, TAB_KEY);

const selectedKey = (r) => r.tabKeys.filter((k, i) => r.selected[i] === "true").join(",");
const openSettings = async (page) => {
  const open = await page.evaluate(() => !document.getElementById("settings").classList.contains("hidden"));
  if (!open) await page.click("#btn-settings");
  await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
  await page.waitForTimeout(120);
};

// Press at `from`, walk to `to` in steps (a real drag, not a teleport: the panel follows pointermove), release.
const drag = async (page, from, to, steps = 8) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(90);
};
const headPoint = (r) => ({ x: Math.round(r.left + 30), y: Math.round(r.top + 14) });
const gripPoint = (r) => ({ x: Math.round(r.left + r.width - 5), y: Math.round(r.top + r.height - 5) });

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the Settings tab strip", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-settings-tabs-"));
  const panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  try {
    console.log(`sandbox: ${panel.base}`);
    await withBrowser(
      async ({ page, pageErrors }) => {
        await page.setViewportSize(WIDE);
        await openPage(page, panel.base, { selector: "#btn-settings" });
        await page.waitForTimeout(250);

        // ---- A. one tab per key, in the markup's order ---------------------------------------------------------
        const boot = await read(page);
        check(boot.stripRole === "tablist", "the strip is a tablist", boot.stripRole);
        check(boot.tabCount === 11, "eleven tabs, one per group", `${boot.tabCount} tabs`);
        check(boot.panelCount === 11, "eleven panels", `${boot.panelCount} panels`);
        check(JSON.stringify(boot.tabKeys) === JSON.stringify(KEYS), "the tabs are the eleven keys, in markup order", boot.tabKeys.join(","));
        check(JSON.stringify(boot.panelKeys) === JSON.stringify(KEYS), "and the panels are in the same order", boot.panelKeys.join(","));
        check(JSON.stringify(boot.labels) === JSON.stringify(LABELS), "each tab carries its group's label", boot.labels.join(" / "));
        check(boot.roles.length === 11 && boot.roles.every((r) => r === "tab"), "every tab has role=tab");
        check(boot.panelCount === 11 && boot.panelRoles.every((r) => r === "tabpanel"), "every panel has role=tabpanel");
        check(boot.tabCount === 11 && boot.controls.every((c, i) => c === `settings-panel-${boot.tabKeys[i]}`), "aria-controls ties each tab to its own panel");
        check(boot.panelCount === 11 && boot.panelLabelled.every((l, i) => l === `settings-tab-${boot.panelKeys[i]}`), "and aria-labelledby names each panel by its tab");
        check(boot.stored === null, "a first visit writes no tab key just by loading", String(boot.stored));
        if (!boot.tabCount) {
          // 0.63.0's Settings is the seven folding groups: there is no strip to measure. Say so once and stop,
          // rather than timing out on the first press and losing the ledger.
          check(false, "there is no tab strip at all — this page is still the seven folding groups");
          return;
        }

        await openSettings(page);
        const first = await read(page);
        check(selectedKey(first) === "display", "Display is the tab a first visit lands on", selectedKey(first));
        check(first.tabindex.filter((t) => t === "0").length === 1 && first.tabindex[0] === "0",
          "the strip is ONE Tab stop: the selected tab is the only tabindex=0", first.tabindex.join(","));
        check(JSON.stringify(first.shown) === JSON.stringify(["display"]), "one panel on screen, and it is Display's", first.shown.join(","));

        // ---- A2. the strip is a comfortable size, not a 9.5px eyebrow ------------------------------------------
        // The eight labels were 9.5px in a 3px 3px 4px box: the reader had to lean in to read DISPLAY ... UPDATES,
        // and the click target was 20px tall. A tab strip still reads as a tab strip at 11.5-12px in the same mono
        // face with the uppercase and the letter-spacing kept — the size was the only thing that made it an eyebrow.
        // Read AFTER the panel opens: a hidden tab has no box, so a boot-time measurement would answer 0px tall.
        const style = first.tabStyle;
        check(style && style.font >= 11, "the tab label renders at 11px or larger", style ? style.fontRaw : "no tab");
        check(style && style.height >= 26, "each tab is at least a 26px-tall click target", style ? `${style.height}px tall` : "no tab");
        check(style && style.padding === "4px 8px 5px 8px", "each tab carries 4px 8px 5px horizontal padding", style ? style.padding : "no tab");
        check(style && style.textTransform === "uppercase" && style.letterSpacing !== "normal",
          "the labels keep the uppercase and the letter-spacing", style ? `${style.textTransform} / ${style.letterSpacing}` : "no tab");
        check(style && style.badgeFont !== null && style.badgeFont <= style.font - 1 + 0.01,
          "the count badge is a step smaller than the label", style ? `badge ${style.badgeFont}px vs label ${style.font}px` : "no badge");
        if (style && style.font < 11) note(`old numbers: font ${style.fontRaw}, height ${style.height}px, padding ${style.padding}, badge ${style.badgeFont}px`);

        // ---- B. a press selects, shows that panel only, and remembers ------------------------------------------
        await page.click('[data-settings-tab="gateway"]');
        await page.waitForTimeout(150);
        const onGateway = await read(page);
        check(selectedKey(onGateway) === "gateway", "a press selects the Gateway tab", selectedKey(onGateway));
        check(JSON.stringify(onGateway.shown) === JSON.stringify(["gateway"]), "and only its panel is drawn", onGateway.shown.join(","));
        check(onGateway.tabindex[onGateway.tabKeys.indexOf("gateway")] === "0" && onGateway.tabindex.filter((t) => t === "0").length === 1,
          "the roving tabindex moved with the selection", onGateway.tabindex.join(","));
        check(onGateway.stored === "gateway", `the choice is remembered under ${TAB_KEY}`, String(onGateway.stored));
        const gatewayRow = await page.evaluate(() => {
          const row = document.getElementById("approval-row");
          const r = row ? row.getBoundingClientRect() : null;
          return r ? { height: r.height, top: r.top } : null;
        });
        check(Boolean(gatewayRow) && gatewayRow.height > 4, "the Gateway panel's own rows are on screen", gatewayRow ? `${gatewayRow.height}px tall` : "no #approval-row");

        // ---- C. the keyboard walks and selects ----------------------------------------------------------------
        await page.focus('[data-settings-tab="gateway"]');
        const keyAt = async (key) => {
          await page.keyboard.press(key);
          await page.waitForTimeout(100);
          return read(page);
        };
        const right = await keyAt("ArrowRight");
        check(selectedKey(right) === "skills" && right.focusTab === "skills", "ArrowRight moves to the next tab, selects it and focuses it", `${selectedKey(right)} focus ${right.focusTab}`);
        const left = await keyAt("ArrowLeft");
        check(selectedKey(left) === "gateway", "ArrowLeft comes back", selectedKey(left));
        const home = await keyAt("Home");
        check(selectedKey(home) === "display" && home.focusTab === "display", "Home takes the first tab", `${selectedKey(home)} focus ${home.focusTab}`);
        const end = await keyAt("End");
        check(selectedKey(end) === "bundles" && end.focusTab === "bundles", "End takes the last tab", `${selectedKey(end)} focus ${end.focusTab}`);
        const wrap = await keyAt("ArrowRight");
        check(selectedKey(wrap) === "display", "ArrowRight on the last tab wraps to the first", selectedKey(wrap));
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(100);
        const backWrap = await read(page);
        check(selectedKey(backWrap) === "bundles", "and ArrowLeft on the first wraps to the last", selectedKey(backWrap));
        await page.keyboard.press("Enter");
        await page.waitForTimeout(100);
        const entered = await read(page);
        check(selectedKey(entered) === "bundles", "Enter selects the tab that has the focus", selectedKey(entered));
        await page.keyboard.press(" ");
        await page.waitForTimeout(100);
        const spaced = await read(page);
        check(selectedKey(spaced) === "bundles" && spaced.stored === "bundles", "Space selects it too, and remembers it", `${selectedKey(spaced)} / ${spaced.stored}`);

        // ---- D. the chosen tab survives a reload, before the panel is opened -----------------------------------
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#btn-settings", { timeout: 30_000 });
        await page.waitForTimeout(250);
        const reloaded = await read(page);
        check(selectedKey(reloaded) === "bundles", "after a reload the chosen tab is still selected", selectedKey(reloaded));
        check(JSON.stringify(reloaded.unhidden) === JSON.stringify(["bundles"]), "and its panel is the one painted at load", reloaded.unhidden.join(","));
        await openSettings(page);
        await page.click('[data-settings-tab="display"]');
        await page.waitForTimeout(120);

        // ---- E. the search is GLOBAL ---------------------------------------------------------------------------
        await page.click('[data-settings-tab="display"]');
        await page.click("#settings-search");
        await page.keyboard.type("approval window");
        await page.waitForTimeout(200);
        const revealed = await read(page);
        check(selectedKey(revealed) === "gateway", "a match on a tab the reader is not on REVEALS that tab", selectedKey(revealed));
        check(JSON.stringify(revealed.shown) === JSON.stringify(["gateway"]), "and that tab's panel is the one drawn", revealed.shown.join(","));
        check(revealed.counts.display === "0" && revealed.counts.gateway === "1", "each tab carries its own match count", `display ${revealed.counts.display}, gateway ${revealed.counts.gateway}`);
        check(revealed.badgesShown.display && revealed.badgesShown.gateway, "the badges are on every tab while the query is on");
        check(revealed.ariaLabels.gateway === "Gateway — 1 match", "and the count is in the tab's accessible name", String(revealed.ariaLabels.gateway));
        check(revealed.stored === "display", "the search did not write its reveal as the reader's tab", String(revealed.stored));
        const approvalShown = await page.evaluate(() => document.getElementById("approval-row").getClientRects().length > 0);
        check(approvalShown, "the matching row is on screen, not behind a badge");

        // A word several groups share: every count is real, and they add up to the rows actually left on screen.
        await page.fill("#settings-search", "browser");
        await page.waitForTimeout(200);
        const spread = await read(page);
        const hitTabs = spread.tabKeys.filter((k) => Number(spread.counts[k]) > 0);
        const sum = Object.values(spread.counts).reduce((n, c) => n + Number(c || 0), 0);
        check(hitTabs.length >= 2, "a shared word counts matches in several tabs at once", hitTabs.map((k) => `${k}:${spread.counts[k]}`).join(" "));
        check(spread.visibleRows[selectedKey(spread)] === Number(spread.counts[selectedKey(spread)]),
          "the count on the tab shown equals the rows actually on screen",
          `${spread.counts[selectedKey(spread)]} counted vs ${spread.visibleRows[selectedKey(spread)]} visible (${sum} match the word across all tabs)`);
        check(selectedKey(spread) && Number(spread.counts[selectedKey(spread)]) > 0, "the tab shown is one that actually answers", selectedKey(spread));

        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        const cleared = await read(page);
        check(cleared.query === "" && cleared.open, "Esc clears the box and leaves the panel open", `query ${JSON.stringify(cleared.query)}`);
        check(selectedKey(cleared) === "display", "and the reader's own tab comes back", selectedKey(cleared));
        check(cleared.visibleRows.display === cleared.rowCounts.display, "every row on the tab is back", `${cleared.visibleRows.display}/${cleared.rowCounts.display}`);
        check(Object.values(cleared.badgesShown).every((v) => v === false), "the badges hide again");
        check(Object.values(cleared.ariaLabels).every((v) => v === null), "and the tab's name is its own label again");

        // ---- F. #219: the head drags, the search box does not ---------------------------------------------------
        // The Display panel is taller than the window, so the window is already at its max height and cannot be
        // dragged DOWN. A panel with a few rows gives the gestures room to be measured in both directions.
        await page.click('[data-settings-tab="updates"]');
        await page.waitForTimeout(200);
        const beforeDrag = await read(page);
        check(beforeDrag.grip && near(beforeDrag.grip.width, 18, 0.5) && near(beforeDrag.grip.height, 18, 0.5),
          "the corner grip is the 18x18 it was", beforeDrag.grip ? `${beforeDrag.grip.width}x${beforeDrag.grip.height}` : "no #settings-grip");
        check(beforeDrag.grip?.cursor === "nwse-resize", "and still says it resizes from this corner", beforeDrag.grip?.cursor);
        await drag(page, headPoint(beforeDrag.rect), { x: headPoint(beforeDrag.rect).x - 110, y: headPoint(beforeDrag.rect).y + 70 });
        const dragged = await read(page);
        check(near(dragged.rect.left, beforeDrag.rect.left - 110) && near(dragged.rect.top, beforeDrag.rect.top + 70),
          "a drag on the head carries the window by the pointer's own delta", `${rectText(beforeDrag.rect)} -> ${rectText(dragged.rect)}`);
        const searchBox = await page.evaluate(() => {
          const b = document.getElementById("settings-search").getBoundingClientRect();
          return { x: Math.round(b.left + 30), y: Math.round(b.top + b.height / 2) };
        });
        await drag(page, searchBox, { x: searchBox.x + 80, y: searchBox.y + 60 });
        const afterSearchDrag = await read(page);
        check(near(afterSearchDrag.rect.left, dragged.rect.left, 0.5) && near(afterSearchDrag.rect.top, dragged.rect.top, 0.5),
          "a press inside #settings-search does NOT drag the window", `${rectText(dragged.rect)} -> ${rectText(afterSearchDrag.rect)}`);
        check(afterSearchDrag.focus === "settings-search", "the box takes the focus instead", afterSearchDrag.focus);
        const gripDrag = gripPoint(afterSearchDrag.rect);
        await drag(page, gripDrag, { x: gripDrag.x + 50, y: gripDrag.y + 30 });
        const sized = await read(page);
        check(near(sized.rect.width, afterSearchDrag.rect.width + 50) && near(sized.rect.height, afterSearchDrag.rect.height + 30),
          "the grip still resizes from the bottom-right", `${afterSearchDrag.rect.width}x${afterSearchDrag.rect.height} -> ${sized.rect.width}x${sized.rect.height}`);
        check(sized.storedRect !== null, `the rect is remembered under ${RECT_KEY}`, String(sized.storedRect));

        // ---- G. the rect and the tab survive one reload together ------------------------------------------------
        const kept = await read(page);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#btn-settings", { timeout: 30_000 });
        await page.waitForTimeout(250);
        await openSettings(page);
        const restored = await read(page);
        check(restored.rect && near(restored.rect.left, kept.rect.left, 1) && near(restored.rect.top, kept.rect.top, 1)
          && near(restored.rect.width, kept.rect.width, 1) && near(restored.rect.height, kept.rect.height, 1),
          "the window comes back where it was left", `${rectText(kept.rect)} -> ${rectText(restored.rect)}`);
        check(selectedKey(restored) === "updates", "and the tab comes back with it", selectedKey(restored));

        // ---- H. the three ways out still work -----------------------------------------------------------------
        await page.keyboard.press("Escape");
        await page.waitForTimeout(120);
        const afterEsc = await read(page);
        check(!afterEsc.open, "Esc closes the window");
        await openSettings(page);
        await page.mouse.click(4, WIDE.height - 4);
        await page.waitForTimeout(150);
        const afterOutside = await read(page);
        check(!afterOutside.open, "a press outside it closes it");
        await openSettings(page);
        await page.click("#btn-settings-close");
        await page.waitForTimeout(120);
        const afterClose = await read(page);
        check(!afterClose.open, "and so does its ✕");

        // ---- I. a narrower window keeps the strip whole and the first row on screen ---------------------------
        // The strip WRAPS (it has since the tabs replaced the folds) — the bigger label must not turn it into a
        // scroller or a clipped row of stubs. And the taller strip must not push the first field row under the
        // fold of a 700px-tall window, at the default width or at 640px.
        const firstRowState = () =>
          page.evaluate(() => {
            const body = document.querySelector("#settings .settings-body");
            const shown = [...document.querySelectorAll("#settings .settings-group")].find((g) => !g.hidden);
            const row = shown?.querySelector(".settings-row");
            if (!body || !row) return null;
            const br = body.getBoundingClientRect();
            const rr = row.getBoundingClientRect();
            return {
              visible: rr.top >= br.top - 0.5 && rr.bottom <= br.bottom + 0.5,
              row: { top: +rr.top.toFixed(1), bottom: +rr.bottom.toFixed(1) },
              body: { top: +br.top.toFixed(1), bottom: +br.bottom.toFixed(1) },
            };
          });
        // The earlier drag left the window 390px wide; a first visit opens it in its default 340px box. Forget the
        // dragged rect so this section measures the strip in the width the reader actually opens, not the width a
        // gesture happened to leave behind (a 390px window fits the old 9.5px labels on one row and proves nothing).
        await page.evaluate(() => localStorage.removeItem("wtgui.settingsRect"));
        await page.setViewportSize({ width: 640, height: 900 });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#btn-settings", { timeout: 30_000 });
        await page.waitForTimeout(250);
        await openSettings(page);
        await page.click('[data-settings-tab="updates"]');
        await page.waitForTimeout(200);
        const narrow = await read(page);
        check(narrow.tabStyle && narrow.tabStyle.boxes.length === 11 && JSON.stringify(narrow.labels) === JSON.stringify(LABELS),
          "all eleven labels are still on the strip at 640px", narrow.labels.join(" / "));
        check(narrow.tabStyle && narrow.tabStyle.clipped.length === 0, "and none of them is clipped at 640px",
          narrow.tabStyle ? narrow.tabStyle.clipped.join(",") || "none clipped" : "no tab");
        check(narrow.tabStyle && narrow.tabStyle.rows >= 2, "the strip wraps to more than one row rather than scrolling",
          narrow.tabStyle ? `${narrow.tabStyle.rows} rows` : "no strip");
        check(narrow.tabStyle && !narrow.tabStyle.stripScrollsX, "and the strip itself does not scroll sideways",
          narrow.tabStyle ? String(narrow.tabStyle.stripScrollsX) : "no strip");
        const at640 = await firstRowState();
        check(at640 && at640.visible, "the first field row is still on screen in a 640px-wide window",
          at640 ? `row ${at640.row.top}..${at640.row.bottom} in body ${at640.body.top}..${at640.body.bottom}` : "no row");
        await page.setViewportSize({ width: 1400, height: 700 });
        await page.waitForTimeout(220);
        const tall = await firstRowState();
        check(tall && tall.visible, "the first field row survives a 700px-tall window",
          tall ? `row ${tall.row.top}..${tall.row.bottom} in body ${tall.body.top}..${tall.body.bottom}` : "no row");
        await page.setViewportSize({ width: 640, height: 700 });
        await page.waitForTimeout(220);
        const tallNarrow = await firstRowState();
        check(tallNarrow && tallNarrow.visible, "and at 640px wide in the same 700px-tall window",
          tallNarrow ? `row ${tallNarrow.row.top}..${tallNarrow.row.bottom} in body ${tallNarrow.body.top}..${tallNarrow.body.bottom}` : "no row");

        check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join(" | "));
      },
      { viewport: WIDE, deviceScaleFactor: 1 },
    );
  } finally {
    await panel.stop();
  }

  console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
