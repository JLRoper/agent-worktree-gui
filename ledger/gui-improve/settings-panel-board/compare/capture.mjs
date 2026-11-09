// gui-improve compare capture - Settings -> Board, headless Chromium (the AFTER set).
//
// Feeds ledger/gui-improve/settings-panel-board/compare/after/{capture.json,dom.json,css.json,shots/*.png}. It only reads the page:
// it opens Settings, selects the Board tab, scrolls the panel body (for the presets state) and (for the
// search state) types "flash" into the search box. No setting is saved; nothing on the server is written.
//
// This is the baseline capture script with only its output paths and stage name changed: same viewports,
// same states, same steps and asserts. It runs against the after tree (44b4278 + the change-set), not this
// checkout; run.mjs boots that tree and points PANEL_BASE at it.
//
//   PLAYWRIGHT_BROWSERS_PATH=C:/Users/roper/AppData/Local/ms-playwright \
//   NODE_PATH=C:/Users/roper/AppData/Roaming/npm/node_modules \
//   node ledger/gui-improve/settings-panel-board/compare/capture.mjs
//
// BASE_URL defaults to http://127.0.0.1:7331/ and can be overridden with PANEL_BASE.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser } from "../../../tools/browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = (process.env.PANEL_BASE || "http://127.0.0.1:7331/").replace(/\/?$/, "/");
const OUT = path.join(HERE, "after");
await mkdir(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1024x768", width: 1024, height: 768 },
];

const STATES = [
  {
    name: "open",
    steps: [
      "Fresh browser context at the viewport (no localStorage, so the settings window and tab are at their defaults).",
      "goto " + BASE,
      "wait for #btn-settings and for the first /api/state paint (2.5 s settle).",
      "click #btn-settings to open the Settings window.",
      "click #settings-tab-board (aria-selected=true on the Board tab; #settings-panel-board not hidden).",
      "set #settings .settings-body scrollTop to 0 and wait two animation frames for layout to settle.",
      "assert #settings is visible, #settings-panel-board is the only visible [data-settings-group], and #settings-search is empty.",
    ],
  },
  {
    name: "presets",
    steps: [
      "Reach the open state exactly as above.",
      "scroll #settings .settings-body so the first .settings-presets (the Board reorder pills) sits in the middle of the body: element.scrollIntoView({block:'center'}).",
      "wait two animation frames and 250 ms; record the body's scrollTop in the inventory.",
      "assert the Board tab is still selected and the panel is still the only visible group.",
    ],
  },
  {
    name: "search",
    steps: [
      "Reach the open state exactly as above.",
      'fill #settings-search with "flash" (the Board rows that answer it: Flash time, Flash on events, Grey flash).',
      "wait 900 ms for the filter to paint, then assert the Board tab is still selected and the search badge reads the number of visible rows.",
      "set #settings .settings-body scrollTop to 0 and wait two animation frames.",
    ],
  },
];

const STYLE_PROPS = [
  "display", "position", "top", "right", "bottom", "left", "zIndex", "boxSizing",
  "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
  "marginTop", "marginRight", "marginBottom", "marginLeft",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
  "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius",
  "backgroundColor", "backgroundImage", "color", "opacity", "visibility",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing",
  "textAlign", "textTransform", "whiteSpace", "textOverflow", "wordBreak", "overflowWrap",
  "overflowX", "overflowY", "boxShadow", "transform", "cursor", "pointerEvents",
  "flexDirection", "flexWrap", "flexGrow", "flexShrink", "flexBasis", "alignItems",
  "justifyContent", "alignSelf", "rowGap", "columnGap", "gridTemplateColumns",
  "gridTemplateRows", "gridColumn", "gridRow",
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function rectOf(r) {
  return r
    ? { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }
    : null;
}

// Runs inside the page. Kept self-contained: it is serialised by page.evaluate.
function collectInventory({ styleProps }) {
  const painted = (el) => {
    const shown = (n) => {
      if (!n.getClientRects().length) return false;
      const cs = getComputedStyle(n);
      return cs.display !== "none" && cs.visibility !== "hidden";
    };
    if (el.tagName === "OPTION") {
      const sel = el.closest("select");
      return !!sel && shown(sel);
    }
    return shown(el);
  };
  const clean = (s, n = 400) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, bottom: b.bottom, left: b.left, right: b.right };
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (tag === "a") return "link";
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") return "heading";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "textbox";
    }
    return null;
  };
  const nameOf = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
      if (clean(t)) return { name: clean(t), source: "aria-labelledby" };
    }
    const al = el.getAttribute("aria-label");
    if (al && clean(al)) return { name: clean(al), source: "aria-label" };
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const lab = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest("label");
      if (lab) {
        const clone = lab.cloneNode(true);
        clone.querySelectorAll("input,select,textarea,option").forEach((n) => n.remove());
        const t = clean(clone.textContent);
        if (t) return { name: t, source: "label" };
      }
      if (el.getAttribute("placeholder")) return { name: clean(el.getAttribute("placeholder")), source: "placeholder" };
      if (el.getAttribute("title")) return { name: clean(el.getAttribute("title")), source: "title" };
      return { name: "", source: "none" };
    }
    if (el.getAttribute("title") && !clean(el.textContent)) return { name: clean(el.getAttribute("title")), source: "title" };
    return { name: clean(el.textContent), source: "text" };
  };

  const win = document.getElementById("settings");
  const panel = document.getElementById("settings-panel-board");
  const body = win ? win.querySelector(".settings-body") : null;
  const scope = win || document;

  // 1. DOM inventory — every element on the Settings surface, plus the option rows inside a select.
  const elements = [];
  const all = [scope, ...scope.querySelectorAll("*")];
  for (const el of all) {
    if (!painted(el)) continue;
    const cs = getComputedStyle(el);
    const nm = nameOf(el);
    const b = rect(el);
    elements.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: el.getAttribute("class") || null,
      role: roleOf(el),
      name: nm.name,
      nameSource: nm.source,
      text: clean(el.textContent),
      box: b,
      painted: el.tagName === "OPTION" ? false : true,
      fontSize: cs.fontSize,
      display: cs.display,
      hidden: !!el.hidden,
      disabled: !!el.disabled,
      value: "value" in el && !["button", "div", "span"].includes(el.tagName.toLowerCase()) ? String(el.value).slice(0, 120) : null,
      checked: "checked" in el ? !!el.checked : null,
      ariaSelected: el.getAttribute("aria-selected"),
    });
  }

  // 2. The General tab's own measurements. These are what a comparison can prove numerically.
  const panelRect = panel ? rect(panel) : null;
  const bodyRect = body ? rect(body) : null;
  const rows = [];
  const groups = [];
  const overflow = [];
  const visibleRows = [];
  if (panel) {
    for (const row of panel.querySelectorAll(".settings-row")) {
      if (!painted(row)) continue;
      const label = clean(row.querySelector("span")?.textContent || row.textContent);
      const control = row.querySelector("input,select,textarea");
      const rb = rect(row);
      const cb = control ? rect(control) : null;
      visibleRows.push(label);
      rows.push({ label, box: rb, control: control ? { tag: control.tagName.toLowerCase(), id: control.id || null, box: cb, right: cb.right } : null });
      if (cb && (cb.right > panelRect.right + 0.5 || cb.left < panelRect.left - 0.5)) {
        overflow.push({ kind: "row-control-outside-panel", label, box: cb, panelRight: panelRect.right });
      }
    }
    for (const presets of panel.querySelectorAll(".settings-presets")) {
      if (!painted(presets)) continue;
      const labelEl = presets.previousElementSibling;
      const next = presets.nextElementSibling;
      const pb = rect(presets);
      const lb = labelEl ? rect(labelEl) : null;
      const nb = next && painted(next) ? rect(next) : null;
      const buttons = [...presets.querySelectorAll("button")].map((b) => ({
        text: clean(b.textContent),
        box: rect(b),
        cls: b.getAttribute("class"),
      }));
      const widths = buttons.map((b) => Math.round(b.box.w * 100) / 100);
      const spread = widths.length ? Math.round((Math.max(...widths) - Math.min(...widths)) * 100) / 100 : 0;
      groups.push({
        label: clean(labelEl?.textContent || ""),
        presetsBox: pb,
        labelBox: lb,
        gapAbove: lb ? Math.round((pb.top - lb.bottom) * 100) / 100 : null,
        gapBelow: nb ? Math.round((nb.top - pb.bottom) * 100) / 100 : panelRect ? Math.round((panelRect.bottom - pb.bottom) * 100) / 100 : null,
        buttons,
        widths,
        spread,
        onCount: buttons.filter((b) => /(^|\s)on(\s|$)/.test(b.cls || "")).length,
      });
      if (pb.right > panelRect.right + 0.5) overflow.push({ kind: "presets-outside-panel", box: pb, panelRight: panelRect.right });
      if (bodyRect && pb.bottom > bodyRect.bottom + 0.5) overflow.push({ kind: "presets-clipped-by-body", box: pb, bodyBottom: bodyRect.bottom });
    }
    for (const el of panel.querySelectorAll("*")) {
      if (!painted(el) || el.tagName === "OPTION") continue;
      const b = rect(el);
      if (b.width === 0 && b.height === 0) continue;
      if (b.right > (bodyRect?.right ?? panelRect.right) + 0.5) overflow.push({ kind: "past-body-right", tag: el.tagName.toLowerCase(), id: el.id || null, box: b });
    }
  }
  const textEls = elements.filter((e) => e.painted && e.text && e.box.w > 0 && e.box.h > 0);
  const minFontSize = textEls.length ? Math.min(...textEls.map((e) => parseFloat(e.fontSize) || 999)) : null;

  // 3. The scan-roots block, the target this baseline records. Every root row's parts are measured
  // separately: the gap between a path and its state chip, and between the chip and the remove control,
  // is the defect a reader sees as "C:/ProjectDevelopmentexists ✕". The add row's input is measured
  // against the hint it carries, so "the field is too narrow to read its own placeholder" is a number.
  const roots = [];
  const rootsEl = document.getElementById("scan-roots");
  if (rootsEl) {
    for (const el of [...rootsEl.children]) {
      if (!painted(el)) continue;
      const kids = [...el.children].filter(painted).map((k) => ({
        tag: k.tagName.toLowerCase(),
        cls: k.getAttribute("class"),
        text: clean(k.textContent, 120),
        box: rect(k),
        title: k.getAttribute("title") || null,
      }));
      const gaps = [];
      for (let i = 1; i < kids.length; i++) gaps.push(Math.round((kids[i].box.left - kids[i - 1].box.right) * 100) / 100);
      roots.push({ cls: el.getAttribute("class"), box: rect(el), kids, gaps, minGap: gaps.length ? Math.min(...gaps) : null });
    }
  }
  const rootInput = document.getElementById("scan-root-input");
  const addBtn = document.getElementById("btn-scan-root-add");
  const addRow = panel ? panel.querySelector(".settings-roots-add") : null;
  let rootAdd = null;
  if (rootInput && painted(rootInput)) {
    const cs = getComputedStyle(rootInput);
    const canvas = document.createElement("canvas").getContext("2d");
    canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const hint = rootInput.getAttribute("placeholder") || "";
    const pad = parseFloat(cs.paddingLeft || 0) + parseFloat(cs.paddingRight || 0) + parseFloat(cs.borderLeftWidth || 0) + parseFloat(cs.borderRightWidth || 0);
    const avail = rootInput.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    const hintPx = canvas.measureText(hint).width;
    rootAdd = {
      row: addRow ? rect(addRow) : null,
      input: rect(rootInput),
      inputClientWidth: rootInput.clientWidth,
      inputBoxSizing: cs.boxSizing,
      placeholder: hint,
      placeholderPx: Math.round(hintPx * 100) / 100,
      placeholderRoom: Math.round(avail * 100) / 100,
      placeholderFits: hintPx <= avail,
      button: addBtn ? { box: rect(addBtn), text: clean(addBtn.textContent, 40) } : null,
      rowFree: addRow && addBtn && rootInput ? Math.round((rect(addRow).right - rect(addBtn).right) * 100) / 100 : null,
    };
  }

  const search = document.getElementById("settings-search");
  const activeTab = document.querySelector("[role='tab'][aria-selected='true']");
  return {
    viewport: { width: innerWidth, height: innerHeight },
    url: location.href,
    win: win ? rect(win) : null,
    winScrollHeight: win ? win.scrollHeight : null,
    body: bodyRect,
    bodyScrollHeight: body ? body.scrollHeight : null,
    bodyScrollTop: body ? body.scrollTop : null,
    panel: panelRect,
    panelScrollHeight: panel ? panel.scrollHeight : null,
    activeTab: activeTab?.dataset?.settingsTab || null,
    visibleGroups: [...document.querySelectorAll("[data-settings-group]")].filter((p) => !p.hidden).map((p) => p.dataset.settingsGroup),
    search: {
      value: search ? search.value : null,
      count: [...document.querySelectorAll(".settings-tab")].find((t) => t.dataset.settingsTab === "board")?.querySelector(".settings-tab-count")?.textContent || null,
    },
    tabCounts: [...document.querySelectorAll(".settings-tab")].map((t) => ({
      tab: t.dataset.settingsTab,
      count: t.querySelector(".settings-tab-count")?.textContent || null,
      badgeVisible: t.querySelector(".settings-tab-count") ? !t.querySelector(".settings-tab-count").hidden : false,
      selected: t.getAttribute("aria-selected") === "true",
    })),
    elementCount: elements.length,
    visibleRows: visibleRows.length,
    rows,
    groups,
    roots,
    rootAdd,
    overflow,
    minFontSize,
    elements,
  };
}

// Runs inside the page: the computed style of every painted element plus the rules that select it.
function collectCss({ styleProps }) {
  const painted = (el) => {
    if (el.tagName === "OPTION") return false;
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };
  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, bottom: b.bottom, left: b.left, right: b.right };
  };

  // Flatten every rule a selector can come from, keeping the sheet and the media condition it sits under.
  const rules = [];
  const sheets = [];
  const atRules = [];
  const walk = (list, sheetIndex, media) => {
    for (const rule of list) {
      if (rule.type === CSSRule.STYLE_RULE) {
        rules.push({
          sheet: sheetIndex,
          media: media || null,
          selector: rule.selectorText,
          style: rule.style.cssText,
        });
      } else if (rule.type === CSSRule.MEDIA_RULE) {
        walk(rule.cssRules, sheetIndex, `${media ? media + " and " : ""}${rule.conditionText || rule.media?.mediaText || ""}`);
      } else if (rule.type === CSSRule.SUPPORTS_RULE) {
        walk(rule.cssRules, sheetIndex, `${media ? media + " and " : ""}@supports ${rule.conditionText || ""}`);
      } else if (rule.type === CSSRule.LAYER_BLOCK_RULE || rule.cssRules) {
        walk(rule.cssRules || [], sheetIndex, media);
      } else {
        atRules.push({ sheet: sheetIndex, type: rule.type, text: String(rule.cssText || "").slice(0, 200) });
      }
    }
  };
  [...document.styleSheets].forEach((sheet, i) => {
    let count = 0;
    try {
      count = sheet.cssRules.length;
      sheets.push({ index: i, href: sheet.href || null, owner: sheet.ownerNode?.tagName?.toLowerCase() || null, id: sheet.ownerNode?.id || null, ruleCount: count });
      walk(sheet.cssRules, i, "");
    } catch (e) {
      sheets.push({ index: i, href: sheet.href || null, owner: sheet.ownerNode?.tagName?.toLowerCase() || null, id: sheet.ownerNode?.id || null, ruleCount: null, error: String(e.message || e) });
    }
  });

  const vars = {};
  const rootCs = getComputedStyle(document.documentElement);
  for (let i = 0; i < rootCs.length; i++) {
    const prop = rootCs.item(i);
    if (prop.startsWith("--")) vars[prop] = rootCs.getPropertyValue(prop).trim();
  }

  const styleOf = (el) => {
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of styleProps) out[p] = cs.getPropertyValue(p.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
    return out;
  };
  const pseudo = (el, which) => {
    const cs = getComputedStyle(el, which);
    if (!cs || cs.content === "none" || cs.content === "normal") return null;
    return {
      content: cs.content,
      display: cs.display,
      width: cs.width,
      height: cs.height,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      position: cs.position,
      top: cs.top,
      right: cs.right,
      bottom: cs.bottom,
      left: cs.left,
    };
  };

  const elements = [];
  const win = document.getElementById("settings") || document;
  const all = [win, ...win.querySelectorAll("*")];
  for (const el of all) {
    if (!painted(el)) continue;
    const matched = [];
    for (let i = 0; i < rules.length; i++) {
      try {
        if (el.matches(rules[i].selector)) matched.push(i);
      } catch {
        /* an unparseable selector never matched anything */
      }
    }
    elements.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: el.getAttribute("class") || null,
      box: rect(el),
      style: styleOf(el),
      matchedRules: matched,
      pseudoBefore: pseudo(el, "::before"),
      pseudoAfter: pseudo(el, "::after"),
    });
  }
  return { sheets, rules, atRules, variables: vars, elementCount: elements.length, elements };
}

const run = await withBrowser(async ({ browser, playwright }) => {
  const shots = [];
  const dom = { schema: "dom-inventory/1", surface: "#settings (Settings window) with #settings-panel-board visible", per_viewport: {} };
  const css = { schema: "css-inventory/1", surface: "#settings", per_viewport: {} };
  const version = await (await fetch(new URL("api/config", BASE))).json();
  const browserVersion = await browser.version();

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message || e)));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push(m.text()); });

    dom.per_viewport[vp.name] = {};
    css.per_viewport[vp.name] = {};

    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector("#btn-settings", { timeout: 30000 });
      await page.waitForTimeout(2500);
      await page.click("#btn-settings");
      await page.waitForTimeout(500);
      await page.click("#settings-tab-board");
      await page.waitForTimeout(700);

      const settle = async () => {
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };

      const assertOpen = async () => {
        const ok = await page.evaluate(() => {
          const win = document.getElementById("settings");
          const panel = document.getElementById("settings-panel-board");
          const active = document.querySelector("[role='tab'][aria-selected='true']");
          return {
            winVisible: !!win && !win.classList.contains("hidden") && !!win.getClientRects().length,
            panelVisible: !!panel && !panel.hidden && !!panel.getClientRects().length,
            activeTab: active?.dataset?.settingsTab || null,
            visibleGroups: [...document.querySelectorAll("[data-settings-group]")].filter((p) => !p.hidden).map((p) => p.dataset.settingsGroup),
          };
        });
        if (!ok.winVisible || !ok.panelVisible || ok.activeTab !== "board") throw new Error(`open state not reached at ${vp.name}: ${JSON.stringify(ok)}`);
        return ok;
      };

      const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });
      const snapshot = async (stateName, inv, cssInv) => {
        const base = `${vp.name}-${stateName}`;
        const pageFile = `ledger/gui-improve/settings-panel-board/compare/after/shots/${base}.png`;
        const surfaceFile = `ledger/gui-improve/settings-panel-board/compare/after/shots/${base}-surface.png`;
        // The whole page first (literal fullPage), then the Settings window: the stable pair the comparison reads.
        await page.screenshot({ path: path.join(OUT, "shots", `${base}.png`), fullPage: true, animations: "disabled", caret: "hide" });
        await page.locator("#settings").screenshot({ path: path.join(OUT, "shots", `${base}-surface.png`), animations: "disabled", caret: "hide" });
        const pageBuf = await readFile(path.join(OUT, "shots", `${base}.png`));
        const surfaceBuf = await readFile(path.join(OUT, "shots", `${base}-surface.png`));

        dom.per_viewport[vp.name][stateName] = {
          viewport: { name: vp.name, width: vp.width, height: vp.height },
          state: stateName,
          steps: STATES.find((s) => s.name === stateName).steps,
          ...inv,
        };
        css.per_viewport[vp.name][stateName] = {
          viewport: { name: vp.name, width: vp.width, height: vp.height },
          state: stateName,
          elementCount: cssInv.elementCount,
          elements: cssInv.elements,
        };
        // The stylesheet and its rules are identical in every context; keep one copy at the top level.
        if (!css.sheets) {
          css.sheets = cssInv.sheets;
          css.rules = cssInv.rules;
          css.atRules = cssInv.atRules;
          css.variables = cssInv.variables;
        }
        shots.push({
          viewport: vp.name,
          viewportSize: { width: vp.width, height: vp.height },
          state: stateName,
          steps: STATES.find((s) => s.name === stateName).steps,
          file: pageFile,
          sha256: sha256(pageBuf),
          bytes: pageBuf.length,
          pixels: pngSize(pageBuf),
          fullPage: true,
          surfaceFile,
          surfaceSha256: sha256(surfaceBuf),
          surfaceBytes: surfaceBuf.length,
          surfacePixels: pngSize(surfaceBuf),
          pair: "surface",
          win: inv.win,
          panel: inv.panel,
          panelScrollHeight: inv.panelScrollHeight,
          bodyScrollHeight: inv.bodyScrollHeight,
          bodyScrollTop: inv.bodyScrollTop,
          visibleRows: inv.visibleRows,
          groups: inv.groups,
          roots: inv.roots,
          rootAdd: inv.rootAdd,
          errors: [...errors],
        });
      };

      // A settings block is rebuilt wholesale by the board's scan (the repaint rule): a read that lands
      // mid-rebuild sees the roots list empty. Read until two consecutive reads agree on the block.
      const stableInventory = async (when) => {
        let prev = null;
        for (let attempt = 0; attempt < 8; attempt++) {
          const now = await page.evaluate(collectInventory, { styleProps: STYLE_PROPS });
          const key = JSON.stringify({ roots: now.roots, rootAdd: now.rootAdd, panelScrollHeight: now.panelScrollHeight, rows: now.visibleRows });
          if (prev && prev.key === key) return now;
          prev = { key, now };
          await page.waitForTimeout(250);
        }
        throw new Error(`${when} at ${vp.name}: the settings block never settled — the roots list kept changing`);
      };

      // state: open — capture it before the scroll and search states change the DOM.
      await assertOpen();
      await page.evaluate(() => { const b = document.querySelector("#settings .settings-body"); if (b) b.scrollTop = 0; });
      await settle();
      await page.waitForTimeout(300);
      await assertOpen();
      const openInv = await stableInventory("open");
      if (!openInv.roots.length) throw new Error(`open state at ${vp.name}: the scan-roots list is empty — nothing to capture`);
      const openCss = await page.evaluate(collectCss, { styleProps: STYLE_PROPS });
      await snapshot("open", openInv, openCss);

      // state: presets — the pill row under the Board reorder control, centred so the row above it,
      // the pills and the preview below are all in the one 340x520 window.
      await page.evaluate(() => {
        const p = document.querySelector("#settings-panel-board .settings-presets");
        if (p) p.scrollIntoView({ block: "center" });
      });
      await settle();
      await page.waitForTimeout(250);
      await assertOpen();
      const presetsInv = await stableInventory("presets");
      if (!(presetsInv.bodyScrollTop > 0)) throw new Error(`presets state at ${vp.name}: the body did not scroll (scrollTop ${presetsInv.bodyScrollTop})`);
      const presetsCss = await page.evaluate(collectCss, { styleProps: STYLE_PROPS });
      await snapshot("presets", presetsInv, presetsCss);

      // state: search
      await page.evaluate(() => { const b = document.querySelector("#settings .settings-body"); if (b) b.scrollTop = 0; });
      await page.fill("#settings-search", "flash");
      await page.waitForTimeout(900);
      await page.evaluate(() => { const b = document.querySelector("#settings .settings-body"); if (b) b.scrollTop = 0; });
      await settle();
      await page.waitForTimeout(250);
      await assertOpen();
      const searchInv = await stableInventory("search");
      if (searchInv.visibleRows < 1) throw new Error(`search state at ${vp.name}: ${searchInv.visibleRows} rows visible, expected at least 1`);
      const searchCss = await page.evaluate(collectCss, { styleProps: STYLE_PROPS });
      await snapshot("search", searchInv, searchCss);
    } finally {
      await context.close().catch(() => {});
    }
  }
  return { shots, dom, css, version, browserVersion };
}, { viewport: { width: 1440, height: 900 }, headless: true });

// Sanity: every viewport × state must have a shot and an element in both inventories.
const incomplete = [];
for (const vp of VIEWPORTS) {
  for (const st of STATES) {
    const shot = run.shots.find((s) => s.viewport === vp.name && s.state === st.name);
    const d = run.dom.per_viewport[vp.name]?.[st.name];
    const c = run.css.per_viewport[vp.name]?.[st.name];
    if (!shot) incomplete.push({ viewport: vp.name, state: st.name, missing: "shot" });
    if (!d || !d.elementCount) incomplete.push({ viewport: vp.name, state: st.name, missing: "dom-inventory" });
    if (!c || !c.elementCount) incomplete.push({ viewport: vp.name, state: st.name, missing: "css-inventory" });
  }
}

await writeFile(path.join(OUT, "dom.json"), JSON.stringify(run.dom, null, 2) + "\n", "utf8");
await writeFile(path.join(OUT, "css.json"), JSON.stringify(run.css, null, 2) + "\n", "utf8");

const [domBuf, cssBuf, styleBuf] = await Promise.all([
  readFile(path.join(OUT, "dom.json")),
  readFile(path.join(OUT, "css.json")),
  readFile(path.join(ROOT, "public/style.css")),
]);
await writeFile(path.join(OUT, "style.css"), styleBuf);

const treeFiles = {};
for (const name of ["public/index.html", "public/app.js", "public/style.css"]) {
  const buf = await readFile(path.join(ROOT, name));
  treeFiles[name] = { sha256: sha256(buf), bytes: buf.length };
}
const served = {};
let panelBuild = null;
for (const [url, name] of [["", "public/index.html"], ["app.js", "public/app.js"], ["style.css", "public/style.css"]]) {
  const res = await fetch(new URL(url, BASE));
  const buf = Buffer.from(await res.arrayBuffer());
  if (name === "public/index.html") {
    const text = buf.toString("utf8");
    panelBuild = /<meta name="panel-build" content="([^"]+)"/.exec(text)?.[1] || null;
  }
  served[name] = { status: res.status, sha256: sha256(buf), bytes: buf.length, matchesTree: sha256(buf) === treeFiles[name].sha256 };
}

const capture = {
  schema: "capture/1",
  pipeline: "gui-improve",
  stage: "compare",
  visit: 1,
  surface: {
    brief: "Settings → Board (the #settings-panel-board tab) at " + BASE + ", with the change-set applied",
    briefText:
      "Run gui-improve again, this time on the Board tab of the panel General settings (settings-panel-board, data-settings-tab=\"board\"), using the new per-stage worktree architecture that is now on main: every stage cut from the one frozen parent, each stage tree recorded under its stage id so all of them stay attached in the chart. Walk baseline, implement, compare, review and correct through the panel driver, not as one local worker. Acceptance is the baseline capture at the recorded viewports and states, an implementation committed on its stage tree, a comparison page pairing every after shot with its before, the review gate free to reject with a note, and the change landed by PR so the improvement is code on main rather than only a ledger entry.",
    url: BASE,
    selector: "#settings-panel-board",
    window: "#settings",
    change: "The 'Folders the board scans' block must read as one control group: a visible gap between each root's path, its state chip and its remove control, and the add-folder field given the width its row has left so its hint is readable.",
    changeSource:
      "Measured in this baseline: the root rows have no gap at all between the path and the 'exists' chip (0 px), 3.9 px between the chip and the remove ✕, and the add-folder input is 154 px of a 310 px row while its own placeholder needs 382.7 px, so it paints as 'an absolute folder pat…' and 74 px of the row stays empty. public/style.css has no rule for .settings-root/.settings-root-path/.settings-root-chip/.settings-root-x/.settings-roots-add at all — lib-side markup from public/app.js:15814-15821, unstyled.",
    reproduce:
      "The captured pixels are the served build's public/index.html, app.js and style.css (hashes in environment). To shoot the after state of an edit in this worktree, serve THIS worktree on a free port with its own PANEL_CONFIG (public/ is read per request; lib/ needs a restart) and follow the same steps at the same viewport and the same body scrollTop. The 340x520 surfaceFile depends only on the public files and the settings config the panel serves (the scan roots it lists), not on the live board behind the window.",
    scope: "The whole Settings window (#settings): its head, search box, tab strip and the visible Board panel. Hidden tabs are not painted and are excluded.",
  },
  environment: {
    browser: `Playwright Chromium ${run.browserVersion} (headless)`,
    deviceScaleFactor: 1,
    serverVersion: run.version.version,
    serverUrl: BASE,
    panelBuild,
    servedNote:
      "public/index.html is rewritten by the panel for cache-busting (stylesheet links carry ?v=<panel-build> and a meta panel-build tag is added), so its hash differs from the tree by that stamp and nothing else; app.js and style.css are byte-identical.",
    servedFiles: served,
    treeFiles,
  },
  viewports: VIEWPORTS.map((v) => ({ name: v.name, width: v.width, height: v.height })),
  states: STATES.map((s) => ({ name: s.name, steps: s.steps })),
  shots: run.shots,
  inventory: {
    dom: { file: "ledger/gui-improve/settings-panel-board/compare/after/dom.json", sha256: sha256(domBuf), bytes: domBuf.length, elements: Object.values(run.dom.per_viewport).reduce((n, v) => n + Object.values(v).reduce((m, s) => m + s.elementCount, 0), 0) },
    css: { file: "ledger/gui-improve/settings-panel-board/compare/after/css.json", sha256: sha256(cssBuf), bytes: cssBuf.length, elements: Object.values(run.css.per_viewport).reduce((n, v) => n + Object.values(v).reduce((m, s) => m + s.elementCount, 0), 0) },
    stylesheet: { file: "ledger/gui-improve/settings-panel-board/compare/after/style.css", sha256: sha256(styleBuf), bytes: styleBuf.length },
    per_viewport: Object.fromEntries(
      VIEWPORTS.map((vp) => [vp.name, Object.fromEntries(STATES.map((st) => [st.name, {
        elements: run.dom.per_viewport[vp.name][st.name].elementCount,
        cssElements: run.css.per_viewport[vp.name][st.name].elementCount,
        rulesMatched: [...new Set(run.css.per_viewport[vp.name][st.name].elements.flatMap((e) => e.matchedRules))].length,
        panelScrollHeight: run.dom.per_viewport[vp.name][st.name].panelScrollHeight,
        bodyScrollHeight: run.dom.per_viewport[vp.name][st.name].bodyScrollHeight,
        visibleRows: run.dom.per_viewport[vp.name][st.name].visibleRows,
        groupSpreads: run.dom.per_viewport[vp.name][st.name].groups.map((g) => ({ label: g.label, spread: g.spread, gapAbove: g.gapAbove, gapBelow: g.gapBelow })),
        roots: (run.dom.per_viewport[vp.name][st.name].roots || []).map((r) => ({ cls: r.cls, h: r.box.h, minGap: r.minGap, gaps: r.gaps })),
        rootAdd: run.dom.per_viewport[vp.name][st.name].rootAdd
          ? {
              inputWidth: run.dom.per_viewport[vp.name][st.name].rootAdd.input.w,
              inputClientWidth: run.dom.per_viewport[vp.name][st.name].rootAdd.inputClientWidth,
              placeholderPx: run.dom.per_viewport[vp.name][st.name].rootAdd.placeholderPx,
              placeholderRoom: run.dom.per_viewport[vp.name][st.name].rootAdd.placeholderRoom,
              placeholderFits: run.dom.per_viewport[vp.name][st.name].rootAdd.placeholderFits,
              buttonWidth: run.dom.per_viewport[vp.name][st.name].rootAdd.button?.box?.w ?? null,
              rowFree: run.dom.per_viewport[vp.name][st.name].rootAdd.rowFree,
            }
          : null,
      }]))]),
    ),
  },
  notes: {
    shotPair:
      "shots[*].file is a full-page screenshot of the whole live board with the Settings window at its recorded win rect; shots[*].surfaceFile is the 340x520 Settings window alone and is the stable pair to diff. The board changes between captures; the Settings window does not.",
    servedIndex:
      "The served public/index.html differs from the tree only by the panel's cache-busting stamp (?v=<panel-build> on stylesheet links and a meta panel-build tag); app.js and style.css are byte-identical to this tree.",
  },
  incomplete,
  recorded_at: new Date().toISOString(),
};
await writeFile(path.join(OUT, "capture.json"), JSON.stringify(capture, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  shots: capture.shots.length,
  viewports: capture.viewports.map((v) => v.name),
  states: capture.states.map((s) => s.name),
  inventory: capture.inventory.per_viewport,
  incomplete,
  files: {
    capture: { bytes: (await stat(path.join(OUT, "capture.json"))).size },
    dom: capture.inventory.dom,
    css: capture.inventory.css,
  },
  served,
}, null, 2));
