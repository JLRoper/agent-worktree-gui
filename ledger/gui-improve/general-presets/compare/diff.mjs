// gui-improve compare — the diff. Reads baseline/ and compare/after/, diffs every shot pair and every
// inventory pair, runs the surface's own tests, and writes:
//   ledger/gui-improve/compare/comparison.json   (comparison/1 — the artifact)
//   ledger/gui-improve/compare/comparison.html   (before / after / diff for every pair, self-contained)
//   ledger/gui-improve/compare/verdict.json      (the G2 word)
//   ledger/gui-improve/compare/diff/*.png        (the diff images the page embeds)
//
// It only reads the captures; the after set must already exist (run.mjs makes it).
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser } from "../../../tools/browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BEFORE_DIR = path.join(ROOT, "ledger/gui-improve/baseline");
const AFTER_DIR = path.join(HERE, "after");
const DIFF_DIR = path.join(HERE, "diff");
const TESTS = ["test/settings-tabs.test.js", "test/assistant-dock-setting.test.js"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const close = (a, b, tol = 0.02) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= tol : a === b);
const px = (v) => (typeof v === "number" ? round(v) : v);

await mkdir(DIFF_DIR, { recursive: true });

const beforeCap = await readJson(path.join(BEFORE_DIR, "capture.json"));
const afterCap = await readJson(path.join(AFTER_DIR, "capture.json"));
const beforeDom = await readJson(path.join(BEFORE_DIR, "dom.json"));
const afterDom = await readJson(path.join(AFTER_DIR, "dom.json"));
const beforeCss = await readJson(path.join(BEFORE_DIR, "css.json"));
const afterCss = await readJson(path.join(AFTER_DIR, "css.json"));

const problems = [];
if (afterCap.incomplete?.length) problems.push({ kind: "after-capture-incomplete", detail: afterCap.incomplete });
if (JSON.stringify(beforeCap.viewports) !== JSON.stringify(afterCap.viewports))
  problems.push({ kind: "viewport-list-differs", before: beforeCap.viewports, after: afterCap.viewports });
if (JSON.stringify(beforeCap.states.map((s) => s.name)) !== JSON.stringify(afterCap.states.map((s) => s.name)))
  problems.push({ kind: "state-list-differs", before: beforeCap.states, after: afterCap.states });

const pairs = [];
for (const vp of afterCap.viewports) {
  for (const st of afterCap.states) {
    const b = beforeCap.shots.find((s) => s.viewport === vp.name && s.state === st.name);
    const a = afterCap.shots.find((s) => s.viewport === vp.name && s.state === st.name);
    if (!b || !a) {
      problems.push({ kind: "pair-missing", viewport: vp.name, state: st.name, before: !!b, after: !!a });
      continue;
    }
    const bFile = path.join(ROOT, b.surfaceFile);
    const aFile = path.join(ROOT, a.surfaceFile);
    const bBuf = await readFile(bFile);
    const aBuf = await readFile(aFile);
    if (sha256(bBuf) !== b.surfaceSha256) problems.push({ kind: "before-surface-hash-mismatch", viewport: vp.name, state: st.name });
    if (sha256(aBuf) !== a.surfaceSha256) problems.push({ kind: "after-surface-hash-mismatch", viewport: vp.name, state: st.name });
    pairs.push({
      viewport: vp.name,
      state: st.name,
      before: { shot: b, surfacePath: bFile },
      after: { shot: a, surfacePath: aFile },
      beforeBuf: bBuf,
      afterBuf: aBuf,
    });
  }
}
if (pairs.length !== beforeCap.viewports.length * beforeCap.states.length)
  problems.push({ kind: "pair-count", expected: beforeCap.viewports.length * beforeCap.states.length, got: pairs.length });

// ---------------------------------------------------------------- pixel diff
const dataUrl = (buf) => "data:image/png;base64," + buf.toString("base64");
const cropRect = (win) => (win ? { x: Math.round(win.x), y: Math.round(win.y), w: Math.round(win.w), h: Math.round(win.h) } : null);

const pixelDiff = await withBrowser(
  async ({ page }) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    const diffOne = (aData, bData, ca, cb) =>
      page.evaluate(
        async ({ a, b, cropA, cropB }) => {
          const load = (src) =>
            new Promise((res, rej) => {
              const i = new Image();
              i.onload = () => res(i);
              i.onerror = () => rej(new Error("image load failed"));
              i.src = src;
            });
          const [A, B] = await Promise.all([load(a), load(b)]);
          const w = cropA ? cropA.w : Math.min(A.naturalWidth, B.naturalWidth);
          const h = cropA ? cropA.h : Math.min(A.naturalHeight, B.naturalHeight);
          const paint = (img, crop, canvas) => {
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, crop ? crop.x : 0, crop ? crop.y : 0, w, h, 0, 0, w, h);
            return ctx.getImageData(0, 0, w, h);
          };
          const tmp = document.createElement("canvas");
          const Apx = paint(A, cropA, tmp);
          const Bpx = paint(B, cropB, tmp);
          const out = document.createElement("canvas");
          out.width = w;
          out.height = h;
          const octx = out.getContext("2d");
          const img2 = octx.createImageData(w, h);
          let changed = 0;
          let visible = 0;
          let strong = 0;
          let sum = 0;
          let max = 0;
          let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
          for (let i = 0, p = 0; i < Apx.data.length; i += 4, p++) {
            const dr = Math.abs(Apx.data[i] - Bpx.data[i]);
            const dg = Math.abs(Apx.data[i + 1] - Bpx.data[i + 1]);
            const db = Math.abs(Apx.data[i + 2] - Bpx.data[i + 2]);
            const da = Math.abs(Apx.data[i + 3] - Bpx.data[i + 3]);
            const d = Math.max(dr, dg, db, da);
            sum += (dr + dg + db) / 3;
            if (d > max) max = d;
            if (d > 0) changed++;
            if (d > 8) {
              visible++;
              const x = p % w;
              const y = (p - x) / w;
              if (x < bx0) bx0 = x;
              if (x > bx1) bx1 = x;
              if (y < by0) by0 = y;
              if (y > by1) by1 = y;
            }
            if (d > 32) strong++;
            if (d > 8) {
              img2.data[i] = 255;
              img2.data[i + 1] = 40;
              img2.data[i + 2] = 40;
              img2.data[i + 3] = 255;
            } else {
              img2.data[i] = Apx.data[i];
              img2.data[i + 1] = Apx.data[i + 1];
              img2.data[i + 2] = Apx.data[i + 2];
              img2.data[i + 3] = 40;
            }
          }
          const diffCanvas = document.createElement("canvas");
          diffCanvas.width = w;
          diffCanvas.height = h;
          const dctx = diffCanvas.getContext("2d");
          dctx.putImageData(img2, 0, 0);
          return {
            width: w,
            height: h,
            pixels: w * h,
            changed,
            visibleDelta: visible,
            strongDelta: strong,
            meanAbsDelta: sum / (w * h),
            maxDelta: max,
            bbox: bx1 >= 0 ? { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } : null,
            diffUrl: diffCanvas.toDataURL("image/png"),
          };
        },
        { a: aData, b: bData, cropA: ca, cropB: cb },
      );

    for (const p of pairs) {
      const ca = cropRect(p.before.shot.win);
      const cb = cropRect(p.after.shot.win);
      const s = await diffOne(dataUrl(p.beforeBuf), dataUrl(p.afterBuf), null, null);
      p.surfaceDiff = { ...s, diffUrl: undefined, diffFile: `ledger/gui-improve/compare/diff/${p.viewport}-${p.state}-surface-diff.png` };
      await writeFile(path.join(ROOT, p.surfaceDiff.diffFile), Buffer.from(s.diffUrl.split(",")[1], "base64"));

      const bPage = await readFile(path.join(ROOT, p.before.shot.file));
      const aPage = await readFile(path.join(ROOT, p.after.shot.file));
      const f = await diffOne(dataUrl(bPage), dataUrl(aPage), ca, cb);
      p.fullPageDiff = {
        ...f,
        diffUrl: undefined,
        crop: { before: ca, after: cb },
        diffFile: `ledger/gui-improve/compare/diff/${p.viewport}-${p.state}-fullpage-crop-diff.png`,
      };
      await writeFile(path.join(ROOT, p.fullPageDiff.diffFile), Buffer.from(f.diffUrl.split(",")[1], "base64"));
    }
    return true;
  },
  { viewport: { width: 1440, height: 900 }, headless: true },
);

// The crop images for the page: re-read the full-page shots and cut the window out in a browser canvas.
const crops = await withBrowser(
  async ({ page }) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    const out = {};
    for (const p of pairs) {
      const key = `${p.viewport}-${p.state}`;
      out[key] = {};
      for (const side of ["before", "after"]) {
        const shot = p[side].shot;
        const buf = await readFile(path.join(ROOT, shot.file));
        const r = cropRect(shot.win);
        out[key][side] = await page.evaluate(
          async ({ src, crop }) => {
            const img = await new Promise((res, rej) => {
              const i = new Image();
              i.onload = () => res(i);
              i.onerror = () => rej(new Error("load failed"));
              i.src = src;
            });
            const c = document.createElement("canvas");
            c.width = crop.w;
            c.height = crop.h;
            c.getContext("2d").drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
            return c.toDataURL("image/png");
          },
          { src: dataUrl(buf), crop: r },
        );
      }
    }
    return out;
  },
  { viewport: { width: 1440, height: 900 }, headless: true },
);

// ---------------------------------------------------------------- inventory diff
const SCALARS = [
  "win",
  "body",
  "panel",
  "winScrollHeight",
  "bodyScrollHeight",
  "bodyScrollTop",
  "panelScrollHeight",
  "elementCount",
  "visibleRows",
  "minFontSize",
  "activeTab",
  "visibleGroups",
  "search",
  "tabCounts",
  "overflow",
];

function walkDiff(a, b, base, out, tol = 0.02) {
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) > tol) out.push({ path: base, before: round(a), after: round(b), delta: round(b - a) });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) walkDiff(a[i], b[i], `${base}[${i}]`, out, tol);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walkDiff(a[k], b[k], base ? `${base}.${k}` : k, out, tol);
    return;
  }
  if (a !== b) out.push({ path: base, before: a, after: b, delta: null });
}

const identity = (e) => `${e.tag}|${e.id ?? ""}|${e.cls ?? ""}`;
const ELEMENT_FIELDS = ["role", "name", "nameSource", "text", "fontSize", "display", "hidden", "disabled", "value", "checked", "ariaSelected"];
const CONTROL_ROLES = new Set(["button", "combobox", "option", "spinbutton", "searchbox", "textbox", "checkbox", "radio", "link"]);

function diffDom(before, after) {
  const out = { scalars: [], elements: { compared: 0, aligned: true, changed: 0, byField: {}, changedElements: [], added: [], removed: [] }, controls: { before: 0, after: 0, roleNameTextChanges: [] }, rows: [], groups: [], overflow: { before: before.overflow.length, after: after.overflow.length, beforeEntries: before.overflow, afterEntries: after.overflow, added: [], removed: [] } };
  for (const k of SCALARS) walkDiff(before[k], after[k], k, out.scalars);

  const be = before.elements;
  const ae = after.elements;
  out.elements.before = be.length;
  out.elements.after = ae.length;
  const aligned = be.length === ae.length && be.every((e, i) => identity(e) === identity(ae[i]));
  out.elements.aligned = aligned;
  const byKey = new Map();
  for (const e of be) byKey.set(identity(e) + "|" + (e.name || "") + "|" + (e.text || ""), e);
  const used = new Set();
  for (let i = 0; i < ae.length; i++) {
    const a = ae[i];
    let b = aligned ? be[i] : null;
    if (!b) {
      const k = identity(a) + "|" + (a.name || "") + "|" + (a.text || "");
      b = byKey.get(k) || null;
      if (b && used.has(b)) b = null;
      if (b) used.add(b);
    }
    if (!b) {
      out.elements.added.push({ tag: a.tag, id: a.id, cls: a.cls, name: a.name, text: a.text, box: px(a.box) });
      continue;
    }
    out.elements.compared++;
    const changes = {};
    for (const f of ELEMENT_FIELDS) if (a[f] !== b[f]) changes[f] = { before: b[f], after: a[f] };
    const geom = {};
    for (const f of ["x", "y", "w", "h", "top", "bottom", "left", "right"]) {
      if (!close(a.box?.[f], b.box?.[f])) {
        geom[f] = { before: px(b.box?.[f]), after: px(a.box?.[f]), delta: px((a.box?.[f] ?? 0) - (b.box?.[f] ?? 0)) };
      }
    }
    if (Object.keys(geom).length) changes.box = geom;
    if (Object.keys(changes).length) {
      out.elements.changed++;
      for (const f of Object.keys(changes)) out.elements.byField[f] = (out.elements.byField[f] || 0) + 1;
      out.elements.changedElements.push({ tag: a.tag, id: a.id, cls: a.cls, name: a.name, text: a.text, changes });
      if (CONTROL_ROLES.has(a.role) && (changes.role || changes.name || changes.text)) {
        out.controls.roleNameTextChanges.push({ tag: a.tag, id: a.id, name: a.name, changes: { role: changes.role, name: changes.name, text: changes.text } });
      }
    }
  }
  for (const e of be) {
    if ((aligned && false) || used.has(e)) continue;
    if (aligned) continue;
    const found = ae.some((a) => identity(a) === identity(e));
    if (!found) out.elements.removed.push({ tag: e.tag, id: e.id, cls: e.cls, name: e.name, text: e.text, box: px(e.box) });
  }
  out.controls.before = be.filter((e) => CONTROL_ROLES.has(e.role)).length;
  out.controls.after = ae.filter((e) => CONTROL_ROLES.has(e.role)).length;
  const controlsOf = (els) =>
    els
      .filter((e) => CONTROL_ROLES.has(e.role))
      .map((e) => ({ tag: e.tag, id: e.id, role: e.role, name: e.name, nameSource: e.nameSource, text: e.text, value: e.value, checked: e.checked, disabled: e.disabled }));
  out.controls.beforeInventory = controlsOf(be);
  out.controls.afterInventory = controlsOf(ae);
  out.controls.identical = JSON.stringify(out.controls.beforeInventory) === JSON.stringify(out.controls.afterInventory);

  const bRows = new Map(before.rows.map((r) => [r.label, r]));
  const aRows = new Map(after.rows.map((r) => [r.label, r]));
  for (const label of new Set([...bRows.keys(), ...aRows.keys()])) {
    const b = bRows.get(label);
    const a = aRows.get(label);
    const row = { label, before: b ? { y: px(b.box.y), h: px(b.box.h), bottom: px(b.box.bottom), controlRight: b.control ? px(b.control.right) : null } : null, after: a ? { y: px(a.box.y), h: px(a.box.h), bottom: px(a.box.bottom), controlRight: a.control ? px(a.control.right) : null } : null };
    row.delta = row.before && row.after ? { y: px(row.after.y - row.before.y), controlRight: row.before.controlRight != null && row.after.controlRight != null ? px(row.after.controlRight - row.before.controlRight) : null } : null;
    out.rows.push(row);
  }

  const bGroups = new Map(before.groups.map((g) => [g.label, g]));
  const aGroups = new Map(after.groups.map((g) => [g.label, g]));
  for (const label of new Set([...bGroups.keys(), ...aGroups.keys()])) {
    const b = bGroups.get(label);
    const a = aGroups.get(label);
    out.groups.push({
      label,
      before: b ? { widths: b.widths, spread: b.spread, gapAbove: b.gapAbove, gapBelow: b.gapBelow, onCount: b.onCount, top: px(b.presetsBox.top), bottom: px(b.presetsBox.bottom) } : null,
      after: a ? { widths: a.widths, spread: a.spread, gapAbove: a.gapAbove, gapBelow: a.gapBelow, onCount: a.onCount, top: px(a.presetsBox.top), bottom: px(a.presetsBox.bottom) } : null,
      delta: b && a ? { spread: px(a.spread - b.spread), gapAbove: px(a.gapAbove - b.gapAbove), gapBelow: px(a.gapBelow - b.gapBelow), bottom: px(a.presetsBox.bottom - b.presetsBox.bottom), onCount: a.onCount - b.onCount } : null,
    });
  }

  const overflowKey = (o) => JSON.stringify({ kind: o.kind, label: o.label ?? null });
  const bKeys = new Set(before.overflow.map(overflowKey));
  const aKeys = new Set(after.overflow.map(overflowKey));
  for (const o of after.overflow) if (!bKeys.has(overflowKey(o))) out.overflow.added.push({ kind: o.kind, label: o.label ?? null });
  for (const o of before.overflow) if (!aKeys.has(overflowKey(o))) out.overflow.removed.push({ kind: o.kind, label: o.label ?? null });
  return out;
}

function diffCss(before, after, be, ae) {
  const out = { rules: { before: before.rules.length, after: after.rules.length, added: [], removed: [] }, sheets: { before: before.sheets.length, after: after.sheets.length }, variables: { before: Object.keys(before.variables).length, after: Object.keys(after.variables).length, changed: [] }, elements: { compared: 0, changed: 0, propertyChanges: 0, byProperty: {}, changedElements: [] } };
  const bSet = new Set(before.rules.map((r) => r.selector + " { " + r.style + " }"));
  const aSet = new Set(after.rules.map((r) => r.selector + " { " + r.style + " }"));
  for (const r of after.rules) if (!bSet.has(r.selector + " { " + r.style + " }")) out.rules.added.push({ selector: r.selector, style: r.style });
  for (const r of before.rules) if (!aSet.has(r.selector + " { " + r.style + " }")) out.rules.removed.push({ selector: r.selector, style: r.style });
  for (const k of new Set([...Object.keys(before.variables), ...Object.keys(after.variables)])) {
    if (before.variables[k] !== after.variables[k]) out.variables.changed.push({ name: k, before: before.variables[k] ?? null, after: after.variables[k] ?? null });
  }
  const n = Math.min(be.length, ae.length);
  for (let i = 0; i < n; i++) {
    const b = be[i];
    const a = ae[i];
    out.elements.compared++;
    const changed = {};
    for (const k of Object.keys(b.style)) if (b.style[k] !== a.style[k]) changed[k] = { before: b.style[k], after: a.style[k] };
    if (Object.keys(changed).length) {
      out.elements.changed++;
      out.elements.propertyChanges += Object.keys(changed).length;
      for (const k of Object.keys(changed)) out.elements.byProperty[k] = (out.elements.byProperty[k] || 0) + 1;
      out.elements.changedElements.push({ tag: a.tag, id: a.id, cls: a.cls, box: px(a.box), changed });
    }
  }
  return out;
}

for (const p of pairs) {
  const bd = beforeDom.per_viewport[p.viewport][p.state];
  const ad = afterDom.per_viewport[p.viewport][p.state];
  const bc = beforeCss.per_viewport[p.viewport][p.state];
  const ac = afterCss.per_viewport[p.viewport][p.state];
  p.dom = diffDom(bd, ad);
  p.css = diffCss(beforeCss, afterCss, bc.elements, ac.elements);
}
const cssGlobal = diffCss(beforeCss, afterCss, beforeCss.per_viewport["1440x900"].open.elements, afterCss.per_viewport["1440x900"].open.elements);

// ---------------------------------------------------------------- tests
const runTests = () =>
  new Promise((resolve) => {
    const chunks = [];
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...TESTS], { cwd: ROOT, windowsHide: true });
    child.stdout.on("data", (d) => chunks.push(String(d)));
    child.stderr.on("data", (d) => chunks.push(String(d)));
    child.on("exit", (code) => {
      const text = chunks.join("");
      const num = (label) => {
        const m = new RegExp(`^# ${label} (\\d+)$`, "m").exec(text);
        return m ? Number(m[1]) : null;
      };
      resolve({
        command: "node --test --test-reporter=tap " + TESTS.join(" "),
        files: TESTS,
        exitCode: code,
        tests: num("tests"),
        pass: num("pass"),
        fail: num("fail"),
        cancelled: num("cancelled"),
        skipped: num("skipped"),
        todo: num("todo"),
        durationMs: num("duration_ms"),
        log: "ledger/gui-improve/compare/tests.log",
        logText: text,
      });
    });
  });

const tests = await runTests();
await writeFile(path.join(HERE, "tests.log"), tests.logText, "utf8");
delete tests.logText;

// ---------------------------------------------------------------- verdict
const allGroups = pairs.flatMap((p) => p.dom.groups.filter((g) => g.state !== "missing"));
const openGroups = pairs.filter((p) => p.state === "open").flatMap((p) => p.dom.groups);
const targetSpreadFixed = openGroups.length > 0 && openGroups.every((g) => g.after && g.after.spread === 0);
const targetHugsField = openGroups.length > 0 && openGroups.every((g) => g.after && g.after.gapAbove < g.after.gapBelow);
const clippingGone = pairs.every((p) => p.state !== "open" || !p.dom.overflow.afterEntries.some((o) => o.kind === "presets-clipped-by-body"));
const controlsIntact = pairs.every((p) => p.dom.controls.roleNameTextChanges.length === 0 && p.dom.controls.identical && p.dom.elements.added.length === 0 && p.dom.elements.removed.length === 0 && p.dom.controls.before === p.dom.controls.after);
const noNewOverflow = pairs.every((p) => p.dom.overflow.added.length === 0);
const fontNotSmaller = pairs.every((p) => (p.dom.scalars.find((s) => s.path === "minFontSize")?.after ?? 999) >= 10);
const testsPass = tests.exitCode === 0 && tests.fail === 0 && tests.pass === 24;
const pixelsMoved = pairs.some((p) => p.surfaceDiff.visibleDelta > 0);
const nothingMoved = pairs.every((p) => p.surfaceDiff.visibleDelta === 0) && allGroups.every((g) => JSON.stringify(g.before) === JSON.stringify(g.after));

const regressions = [];
if (!controlsIntact) regressions.push("a control's role, name or text changed, or an element was added/removed");
if (!noNewOverflow) regressions.push("a new overflow entry appeared");
if (!fontNotSmaller) regressions.push("the smallest painted font shrank");
if (!targetHugsField) regressions.push("a strip still sits closer to the field below than to its own");
if (tests.exitCode !== 0 || tests.fail > 0) regressions.push("the surface's own tests failed");

const outcome = regressions.length ? "regressed" : nothingMoved ? "unchanged" : targetSpreadFixed && targetHugsField && clippingGone ? "improved" : "unchanged";

const changedPixels = pairs.reduce((n, p) => n + p.surfaceDiff.visibleDelta, 0);
const totalPixels = pairs.reduce((n, p) => n + p.surfaceDiff.pixels, 0);
const styleElements = cssGlobal.elements.changed;
const elementGeometry = pairs.reduce((n, p) => n + (p.dom.elements.byField.box || 0), 0);

const summary = {
  pairs: pairs.length,
  shots: pairs.length * 2,
  viewports: afterCap.viewports.map((v) => v.name),
  states: afterCap.states.map((s) => s.name),
  surfacePixelsCompared: totalPixels,
  surfacePixelsMoved: changedPixels,
  surfacePixelsMovedPct: round((changedPixels / totalPixels) * 100, 3),
  target: {
    pillSpreadZeroEverywhere: targetSpreadFixed,
    stripHugsItsField: targetHugsField,
    clippedStripGone: clippingGone,
  },
  integrity: {
    controlsIntact,
    noNewOverflow,
    minFontNotSmaller: fontNotSmaller,
    elementsBefore: pairs[0]?.dom.elements.before ?? null,
    elementsAfter: pairs[0]?.dom.elements.after ?? null,
    styleChangedElements: styleElements,
    elementBoxesChanged: elementGeometry,
  },
  tests: { command: tests.command, exitCode: tests.exitCode, tests: tests.tests, pass: tests.pass, fail: tests.fail },
  problems,
};

const evidence = [];
const openB = pairs.find((p) => p.viewport === "1440x900" && p.state === "open");
if (openB) {
  for (const g of openB.dom.groups) {
    if (g.before && g.after)
      evidence.push(
        `${g.label}: pill widths ${g.before.widths.join(" / ")} (spread ${g.before.spread}) → ${g.after.widths.join(" / ")} (spread ${g.after.spread}); gap above/below ${g.before.gapAbove}/${g.before.gapBelow} → ${g.after.gapAbove}/${g.after.gapBelow}`,
      );
  }
  evidence.push(`General panel content height ${round(openB.dom.scalars.find((s) => s.path === "panel.h")?.before ?? openB.before.shot.panel.h)} → ${round(openB.dom.scalars.find((s) => s.path === "panel.h")?.after ?? openB.after.shot.panel.h)} px; body/panel scroll heights ${openB.before.shot.bodyScrollHeight}/${openB.before.shot.panelScrollHeight} → ${openB.after.shot.bodyScrollHeight}/${openB.after.shot.panelScrollHeight}`);
  const bBody = beforeDom.per_viewport[openB.viewport].open.body;
  const aBody = afterDom.per_viewport[openB.viewport].open.body;
  const clippedB = openB.before.shot.groups.some((g) => g.presetsBox.bottom > bBody.bottom);
  evidence.push(`last strip bottom vs the body's visible bottom: ${px(Math.max(...openB.before.shot.groups.map((g) => g.presetsBox.bottom)))} vs ${px(bBody.bottom)} → ${px(Math.max(...openB.after.shot.groups.map((g) => g.presetsBox.bottom)))} vs ${px(aBody.bottom)}${clippedB ? " (clipped before)" : ""}`);
}
evidence.push(`surface pixels moved: ${changedPixels} of ${totalPixels} (${summary.surfacePixelsMovedPct}%) across ${pairs.length} pairs; per pair ${pairs.map((p) => `${p.viewport}/${p.state} ${p.surfaceDiff.visibleDelta}`).join(", ")}`);
evidence.push(`DOM inventory: ${summary.integrity.elementsBefore} → ${summary.integrity.elementsAfter} elements per pair; role/name/text changes on controls: ${pairs.reduce((n, p) => n + p.dom.controls.roleNameTextChanges.length, 0)}; elements added/removed: ${pairs.reduce((n, p) => n + p.dom.elements.added.length + p.dom.elements.removed.length, 0)}`);
evidence.push(`CSS inventory: ${afterCss.rules.length - beforeCss.rules.length} rules added, ${pairs[0]?.css.rules.removed.length ?? 0} removed; ${styleElements} painted elements changed style (the three strips, their twelve buttons, and the General panel's height); :root variables changed: ${pairs[0]?.css.variables.changed.length ?? 0}`);
evidence.push(`tests: ${tests.command} → exit ${tests.exitCode}, ${tests.pass} pass, ${tests.fail} fail, ${tests.tests} total`);

const comparison = {
  schema: "comparison/1",
  pipeline: "gui-improve",
  stage: "compare",
  visit: 1,
  surface: beforeCap.surface,
  inputs: {
    changeSet: { file: "ledger/gui-improve/change-set.patch", sha256: sha256(await readFile(path.join(ROOT, "ledger/gui-improve/change-set.patch"))), appliedInTree: true },
    baseline: {
      capture: "ledger/gui-improve/baseline/capture.json",
      sha256: sha256(await readFile(path.join(BEFORE_DIR, "capture.json"))),
      dom: "ledger/gui-improve/baseline/dom.json",
      css: "ledger/gui-improve/baseline/css.json",
      commit: "21d6423e0e8f",
    },
    after: {
      capture: "ledger/gui-improve/compare/after/capture.json",
      sha256: sha256(await readFile(path.join(AFTER_DIR, "capture.json"))),
      dom: "ledger/gui-improve/compare/after/dom.json",
      css: "ledger/gui-improve/compare/after/css.json",
      commit: "c065c4f",
    },
    head: "c065c4f",
  },
  environment: afterCap.environment,
  protocol: {
    viewports: afterCap.viewports,
    states: afterCap.states.map((s) => ({ name: s.name, steps: s.steps })),
    sameAsBaseline: JSON.stringify(afterCap.viewports) === JSON.stringify(beforeCap.viewports) && JSON.stringify(afterCap.states.map((s) => s.name)) === JSON.stringify(beforeCap.states.map((s) => s.name)),
    notes: afterCap.notes,
  },
  pairs: pairs.map((p) => ({
    viewport: p.viewport,
    state: p.state,
    before: {
      shot: p.before.shot.surfaceFile,
      sha256: p.before.shot.surfaceSha256,
      pixels: p.before.shot.surfacePixels,
      win: p.before.shot.win,
      panel: p.before.shot.panel,
      bodyScrollHeight: p.before.shot.bodyScrollHeight,
      panelScrollHeight: p.before.shot.panelScrollHeight,
      visibleRows: p.before.shot.visibleRows,
      groups: p.before.shot.groups.map((g) => ({ label: g.label, widths: g.widths, spread: g.spread, gapAbove: g.gapAbove, gapBelow: g.gapBelow, onCount: g.onCount })),
      fullPage: { file: p.before.shot.file, sha256: p.before.shot.sha256, pixels: p.before.shot.pixels },
    },
    after: {
      shot: p.after.shot.surfaceFile,
      sha256: p.after.shot.surfaceSha256,
      pixels: p.after.shot.surfacePixels,
      win: p.after.shot.win,
      panel: p.after.shot.panel,
      bodyScrollHeight: p.after.shot.bodyScrollHeight,
      panelScrollHeight: p.after.shot.panelScrollHeight,
      visibleRows: p.after.shot.visibleRows,
      groups: p.after.shot.groups.map((g) => ({ label: g.label, widths: g.widths, spread: g.spread, gapAbove: g.gapAbove, gapBelow: g.gapBelow, onCount: g.onCount })),
      fullPage: { file: p.after.shot.file, sha256: p.after.shot.sha256, pixels: p.after.shot.pixels },
    },
    pixelDiff: { surface: p.surfaceDiff, fullPageWindowCrop: p.fullPageDiff },
    dom: p.dom,
    css: p.css,
    shots: {
      surface: {
        before: relPath(p.before.shot.surfaceFile),
        after: relPath(p.after.shot.surfaceFile),
        diff: p.surfaceDiff.diffFile,
      },
      fullPage: {
        before: relPath(p.before.shot.file),
        after: relPath(p.after.shot.file),
        diff: p.fullPageDiff.diffFile,
      },
    },
  })),
  summary,
  verdict: { outcome, reasons: evidence, regressions },
  tests,
  generated_at: new Date().toISOString(),
};

function relPath(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

await writeFile(path.join(HERE, "comparison.json"), JSON.stringify(comparison, null, 2) + "\n", "utf8");

// ---------------------------------------------------------------- the page
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const imgData = async (p) => "data:image/png;base64," + (await readFile(path.join(ROOT, p))).toString("base64");
const imgTag = (src, alt) => `<img src="${src}" alt="${esc(alt)}">`;

const rows = [];
for (const p of pairs) {
  const key = `${p.viewport}-${p.state}`;
  const surfaceB = await imgData(p.before.shot.surfaceFile);
  const surfaceA = await imgData(p.after.shot.surfaceFile);
  const surfaceD = await imgData(p.surfaceDiff.diffFile);
  const fullD = await imgData(p.fullPageDiff.diffFile);
  const cropB = crops[key].before;
  const cropA = crops[key].after;
  const g = p.dom.groups
    .map(
      (x) =>
        `<tr><td>${esc(x.label)}</td><td>${esc(x.before ? x.before.widths.join(" / ") : "—")}</td><td>${esc(x.after ? x.after.widths.join(" / ") : "—")}</td><td>${x.before ? x.before.spread : "—"}</td><td>${x.after ? x.after.spread : "—"}</td><td>${x.before ? x.before.gapAbove + " / " + x.before.gapBelow : "—"} → ${x.after ? x.after.gapAbove + " / " + x.after.gapBelow : "—"}</td></tr>`,
    )
    .join("");
  const styleList = p.css.elements.changedElements
    .map((e) => `<li><code>${esc(e.tag)}${e.id ? "#" + esc(e.id) : ""}${e.cls ? "." + esc(e.cls.split(/\s+/).join(".")) : ""}</code> — ${esc(Object.keys(e.changed).join(", "))}</li>`)
    .join("");
  const boxList = p.dom.elements.changedElements
    .filter((e) => e.changes.box)
    .map((e) => `<li><code>${esc(e.tag)}${e.id ? "#" + esc(e.id) : ""}${e.cls ? "." + esc(e.cls.split(/\s+/).join(".")) : ""}</code> — ${esc(Object.entries(e.changes.box).map(([k, v]) => `${k} ${v.before} → ${v.after}`).join(", "))}</li>`)
    .join("");
  const controlList = p.dom.controls.afterInventory
    .map((e) => `<li><code>${esc(e.role)}</code> “${esc(e.name || e.text)}”${e.id ? ` <code>#${esc(e.id)}</code>` : ""}${e.value != null ? ` value ${esc(e.value)}` : ""}</li>`)
    .join("");
  rows.push(`<section class="pair">
  <h2>${esc(p.viewport)} — ${esc(p.state)}</h2>
  <p class="stats">surface diff: <b>${p.surfaceDiff.visibleDelta}</b> px changed (${round((p.surfaceDiff.visibleDelta / p.surfaceDiff.pixels) * 100, 2)}%), mean Δ ${round(p.surfaceDiff.meanAbsDelta, 2)}, max Δ ${p.surfaceDiff.maxDelta}; full-page window crop: ${p.fullPageDiff.visibleDelta} px changed.
  ${p.surfaceDiff.bbox ? `changed bbox x${p.surfaceDiff.bbox.x} y${p.surfaceDiff.bbox.y} ${p.surfaceDiff.bbox.w}×${p.surfaceDiff.bbox.h}.` : "no visible pixel changed."}</p>
  <p class="stats">controls: <b>${p.dom.controls.before}</b> before / <b>${p.dom.controls.after}</b> after; role, name and text identical: <b>${p.dom.controls.identical ? "yes" : "NO"}</b>; elements added/removed: <b>${p.dom.elements.added.length}/${p.dom.elements.removed.length}</b>.</p>
  <details><summary>control inventory — role, name and text of all ${p.dom.controls.after} controls</summary><ul>${controlList}</ul></details>
  <div class="shot"><figure><figcaption>before</figcaption>${imgTag(surfaceB, "before")}</figure><figure><figcaption>after</figcaption>${imgTag(surfaceA, "after")}</figure><figure><figcaption>diff (red = changed)</figcaption>${imgTag(surfaceD, "diff")}</figure></div>
  <details><summary>full-page shot — the same Settings window region, before / after / diff</summary>
    <div class="shot"><figure><figcaption>before</figcaption>${imgTag(cropB, "before crop")}</figure><figure><figcaption>after</figcaption>${imgTag(cropA, "after crop")}</figure><figure><figcaption>diff</figcaption>${imgTag(fullD, "diff")}</figure></div>
  </details>
  <table><thead><tr><th>preset strip</th><th>widths before</th><th>widths after</th><th>spread before</th><th>spread after</th><th>gap above → below (Δ)</th></tr></thead><tbody>${g}</tbody></table>
  ${styleList ? `<details><summary>computed-style changes on ${p.css.elements.changed} element(s)</summary><ul>${styleList}</ul></details>` : "<p>no computed-style changes.</p>"}
  ${boxList ? `<details><summary>geometry changes on ${p.dom.elements.byField.box || 0} element(s)</summary><ul>${boxList}</ul></details>` : "<p>no element geometry changes.</p>"}
</section>`);
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Settings → General — before / after / diff</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px 32px; background: #14181d; color: #d7dee7; font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 22px; margin: 0 0 6px; color: #fff; }
  h2 { font-size: 16px; margin: 0 0 4px; color: #fff; }
  .verdict { display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; font-size: 12px; }
  .improved { background: #123a25; color: #6ee7a8; border: 1px solid #1f6b45; }
  .unchanged { background: #2c2c2c; color: #bbb; border: 1px solid #444; }
  .regressed { background: #3d1616; color: #ff9b9b; border: 1px solid #7a2a2a; }
  .lead { color: #9aa7b6; max-width: 900px; }
  .pair { margin: 30px 0 0; padding: 18px 20px; background: #1a1f26; border: 1px solid #28303a; border-radius: 10px; }
  .stats { color: #9aa7b6; margin: 4px 0 12px; font-size: 13px; }
  .shot { display: flex; flex-wrap: wrap; gap: 16px; align-items: start; }
  figure { margin: 0; }
  figcaption { font-size: 12px; color: #8b98a7; margin-bottom: 4px; text-transform: uppercase; letter-spacing: .06em; }
  img { width: 340px; height: 520px; image-rendering: pixelated; border: 1px solid #2b333d; border-radius: 6px; background: #0d1013; }
  table { border-collapse: collapse; margin: 14px 0 8px; font-size: 13px; }
  th, td { text-align: left; padding: 4px 12px 4px 0; border-bottom: 1px solid #262e37; vertical-align: top; }
  th { color: #8b98a7; font-weight: 600; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #c8d3df; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: #9aa7b6; }
  ul { margin: 6px 0; padding-left: 20px; }
  .tests { color: #6ee7a8; }
  .tests.bad { color: #ff9b9b; }
</style></head><body>
<h1>Settings → General — before / after / diff</h1>
<p><span class="verdict ${esc(outcome)}">${esc(outcome)}</span></p>
<p class="lead">${esc(beforeCap.surface.change)}. ${esc(pairs.length)} pairs: ${esc(afterCap.viewports.map((v) => v.name).join(", "))} × ${esc(afterCap.states.map((s) => s.name).join(", "))}. Same steps and asserts as the baseline. Tests: <span class="tests ${tests.exitCode === 0 ? "" : "bad"}">${tests.pass} pass / ${tests.fail} fail, exit ${tests.exitCode}</span>.</p>
<ul>${evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
${rows.join("\n")}
</body></html>`;

await writeFile(path.join(HERE, "comparison.html"), html, "utf8");

const verdict = {
  gate: "G2",
  outcome,
  pipeline: "gui-improve",
  stage: "compare",
  visit: 1,
  surface: "settings-panel-general",
  baseline: "21d6423e0e8f",
  after: "c065c4f",
  viewports: afterCap.viewports.map((v) => v.name),
  states: afterCap.states.map((s) => s.name),
  pairs: pairs.length,
  shots: pairs.length * 2,
  pixels_moved: changedPixels,
  pixels_compared: totalPixels,
  tests: { command: tests.command, exit_code: tests.exitCode, pass: tests.pass, fail: tests.fail, total: tests.tests },
  evidence,
  regressions,
  comparison: "ledger/gui-improve/compare/comparison.json",
  page: "ledger/gui-improve/compare/comparison.html",
  checked_at: new Date().toISOString(),
};
await writeFile(path.join(HERE, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");

console.log(JSON.stringify({ outcome, pairs: pairs.length, pixelsMoved: changedPixels, styleElements, tests: verdict.tests, problems, evidence }, null, 2));
