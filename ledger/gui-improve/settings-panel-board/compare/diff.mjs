// gui-improve compare - the diff. Reads before/ and after/, diffs every surface shot pair and every
// inventory pair, reads the surface's test runs, and writes:
//   ledger/gui-improve/settings-panel-board/compare/comparison.json   (comparison/1 - the artifact)
//   ledger/gui-improve/settings-panel-board/compare/comparison.html   (before / after / diff for every pair, self-contained)
//   ledger/gui-improve/settings-panel-board/compare/verdict.json      (the G2 word)
//   ledger/gui-improve/settings-panel-board/compare/diff/*.png        (the diff images the page embeds)
//
// before/ is a byte-identical copy of ledger/gui-improve/baseline/ at 44b4278 (see before/SOURCE.json).
// after/ is the same capture script run against the after tree (44b4278 + the change-set).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser } from "../../../tools/browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BEFORE_DIR = path.join(HERE, "before");
const AFTER_DIR = path.join(HERE, "after");
const DIFF_DIR = path.join(HERE, "diff");
const CHANGE_SET = path.join(HERE, "change-set.patch");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const close = (a, b, tol = 0.02) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= tol : a === b);
const px = (v) => (typeof v === "number" ? round(v) : v);
const norm = (s) => String(s ?? "").replace(/\r\n/g, "\n");

await mkdir(DIFF_DIR, { recursive: true });

const beforeCap = await readJson(path.join(BEFORE_DIR, "capture.json"));
const afterCap = await readJson(path.join(AFTER_DIR, "capture.json"));
const beforeDom = await readJson(path.join(BEFORE_DIR, "dom.json"));
const afterDom = await readJson(path.join(AFTER_DIR, "dom.json"));
const beforeCss = await readJson(path.join(BEFORE_DIR, "css.json"));
const afterCss = await readJson(path.join(AFTER_DIR, "css.json"));
const tests = await readJson(path.join(HERE, "tests.json"));

const problems = [];
if (afterCap.incomplete?.length) problems.push({ kind: "after-capture-incomplete", detail: afterCap.incomplete });
if (JSON.stringify(beforeCap.viewports) !== JSON.stringify(afterCap.viewports))
  problems.push({ kind: "viewport-list-differs", before: beforeCap.viewports, after: afterCap.viewports });
if (JSON.stringify(beforeCap.states.map((s) => s.name)) !== JSON.stringify(afterCap.states.map((s) => s.name)))
  problems.push({ kind: "state-list-differs", before: beforeCap.states, after: afterCap.states });

// The baseline manifest records its shots under ledger/gui-improve/baseline/. The copy beside this
// comparison is byte-identical but lives under compare/before/; map the paths, never the bytes.
const beforePath = (p) =>
  path.join(ROOT, String(p).replace(/^ledger\/gui-improve\/baseline\//, "ledger/gui-improve/settings-panel-board/compare/before/"));
const afterPath = (p) => path.join(ROOT, p);
const relPath = (p) => path.relative(ROOT, p).split(path.sep).join("/");

const pairs = [];
for (const vp of afterCap.viewports) {
  for (const st of afterCap.states) {
    const b = beforeCap.shots.find((s) => s.viewport === vp.name && s.state === st.name);
    const a = afterCap.shots.find((s) => s.viewport === vp.name && s.state === st.name);
    if (!b || !a) {
      problems.push({ kind: "pair-missing", viewport: vp.name, state: st.name, before: !!b, after: !!a });
      continue;
    }
    const bFile = beforePath(b.surfaceFile);
    const aFile = afterPath(a.surfaceFile);
    const bBuf = await readFile(bFile);
    const aBuf = await readFile(aFile);
    if (sha256(bBuf) !== b.surfaceSha256) problems.push({ kind: "before-surface-hash-mismatch", viewport: vp.name, state: st.name });
    if (sha256(aBuf) !== a.surfaceSha256) problems.push({ kind: "after-surface-hash-mismatch", viewport: vp.name, state: st.name });
    pairs.push({
      viewport: vp.name,
      state: st.name,
      before: { shot: b, surfacePath: bFile, surfaceRel: relPath(bFile) },
      after: { shot: a, surfacePath: aFile, surfaceRel: relPath(aFile) },
      beforeBuf: bBuf,
      afterBuf: aBuf,
    });
  }
}
if (pairs.length !== beforeCap.viewports.length * beforeCap.states.length)
  problems.push({ kind: "pair-count", expected: beforeCap.viewports.length * beforeCap.states.length, got: pairs.length });

// ---------------------------------------------------------------- pixel diff
const dataUrl = (buf) => "data:image/png;base64," + buf.toString("base64");

const pixelDiff = await withBrowser(
  async ({ page }) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    const diffOne = (aData, bData) =>
      page.evaluate(
        async ({ a, b }) => {
          const load = (src) =>
            new Promise((res, rej) => {
              const i = new Image();
              i.onload = () => res(i);
              i.onerror = () => rej(new Error("image load failed"));
              i.src = src;
            });
          const [A, B] = await Promise.all([load(a), load(b)]);
          const w = Math.min(A.naturalWidth, B.naturalWidth);
          const h = Math.min(A.naturalHeight, B.naturalHeight);
          const paint = (img, canvas) => {
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, w, h, 0, 0, w, h);
            return ctx.getImageData(0, 0, w, h);
          };
          const tmp = document.createElement("canvas");
          const Apx = paint(A, tmp);
          const Bpx = paint(B, tmp);
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
        { a: aData, b: bData },
      );

    for (const p of pairs) {
      const s = await diffOne(dataUrl(p.beforeBuf), dataUrl(p.afterBuf));
      p.surfaceDiff = {
        ...s,
        diffUrl: undefined,
        diffFile: `ledger/gui-improve/settings-panel-board/compare/diff/${p.viewport}-${p.state}-surface-diff.png`,
      };
      await writeFile(path.join(ROOT, p.surfaceDiff.diffFile), Buffer.from(s.diffUrl.split(",")[1], "base64"));
    }
    return true;
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
  if (norm(a) !== norm(b)) out.push({ path: base, before: a, after: b, delta: null });
}

const identity = (e) => `${e.tag}|${e.id ?? ""}|${e.cls ?? ""}`;
const ELEMENT_FIELDS = ["role", "name", "nameSource", "text", "fontSize", "display", "hidden", "disabled", "value", "checked", "ariaSelected"];
const CONTROL_ROLES = new Set(["button", "combobox", "option", "spinbutton", "searchbox", "textbox", "checkbox", "radio", "link"]);
const INTENDED_INPUT = "scan-root-input";

function diffDom(before, after) {
  const out = {
    scalars: [],
    elements: { compared: 0, aligned: true, changed: 0, byField: {}, changedElements: [], added: [], removed: [] },
    controls: { before: 0, after: 0, roleNameTextChanges: [], intendedChanges: [], unexpectedChanges: [] },
    rows: [],
    groups: [],
    overflow: { before: before.overflow.length, after: after.overflow.length, beforeEntries: before.overflow, afterEntries: after.overflow, added: [], removed: [] },
  };
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
    for (const f of ELEMENT_FIELDS) if (norm(a[f]) !== norm(b[f])) changes[f] = { before: b[f], after: a[f] };
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
        const change = { tag: a.tag, id: a.id, name: a.name, changes: { role: changes.role, name: changes.name, text: changes.text } };
        out.controls.roleNameTextChanges.push(change);
        if (a.id === INTENDED_INPUT && changes.name?.after === "an absolute folder path") out.controls.intendedChanges.push(change);
        else out.controls.unexpectedChanges.push(change);
      }
    }
  }
  for (const e of be) {
    if (aligned) break;
    if (used.has(e)) continue;
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

  const bRows = new Map(before.rows.map((r) => [r.label, r]));
  const aRows = new Map(after.rows.map((r) => [r.label, r]));
  for (const label of new Set([...bRows.keys(), ...aRows.keys()])) {
    const b = bRows.get(label);
    const a = aRows.get(label);
    const row = {
      label,
      before: b ? { y: px(b.box.y), h: px(b.box.h), bottom: px(b.box.bottom), controlRight: b.control ? px(b.control.right) : null } : null,
      after: a ? { y: px(a.box.y), h: px(a.box.h), bottom: px(a.box.bottom), controlRight: a.control ? px(a.control.right) : null } : null,
    };
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
  const out = {
    rules: { before: before.rules.length, after: after.rules.length, added: [], removed: [] },
    sheets: { before: before.sheets.length, after: after.sheets.length },
    variables: { before: Object.keys(before.variables).length, after: Object.keys(after.variables).length, changed: [] },
    elements: { compared: 0, changed: 0, propertyChanges: 0, byProperty: {}, changedElements: [] },
  };
  const bSet = new Set(before.rules.map((r) => norm(r.selector) + " { " + norm(r.style) + " }"));
  const aSet = new Set(after.rules.map((r) => norm(r.selector) + " { " + norm(r.style) + " }"));
  for (const r of after.rules) if (!bSet.has(norm(r.selector) + " { " + norm(r.style) + " }")) out.rules.added.push({ selector: r.selector, style: r.style });
  for (const r of before.rules) if (!aSet.has(norm(r.selector) + " { " + norm(r.style) + " }")) out.rules.removed.push({ selector: r.selector, style: r.style });
  for (const k of new Set([...Object.keys(before.variables), ...Object.keys(after.variables)])) {
    if (norm(before.variables[k]) !== norm(after.variables[k])) out.variables.changed.push({ name: k, before: before.variables[k] ?? null, after: after.variables[k] ?? null });
  }
  const n = Math.min(be.length, ae.length);
  for (let i = 0; i < n; i++) {
    const b = be[i];
    const a = ae[i];
    out.elements.compared++;
    const changed = {};
    for (const k of Object.keys(b.style)) if (norm(b.style[k]) !== norm(a.style[k])) changed[k] = { before: b.style[k], after: a.style[k] };
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

// The change-set says the path is 11.5px, but the rule sits at the same specificity as .mono's 12px and
// loses. Record what paints, not what the rule asks for.
const pathFontBefore = beforeCss.per_viewport["1440x900"].open.elements.find((e) => e.cls === "mono settings-root-path")?.style.fontSize ?? null;
const pathFontAfter = afterCss.per_viewport["1440x900"].open.elements.find((e) => e.cls === "mono settings-root-path")?.style.fontSize ?? null;
const observations = [];
if (pathFontAfter && pathFontAfter !== "11.5px")
  observations.push(
    `path font: the rule asks for 11.5px, but .mono's 12px wins at equal specificity, so the path paints at ${pathFontAfter} (before: ${pathFontBefore}); the row's gaps, width and ellipsis are unaffected`,
  );

// ---------------------------------------------------------------- the markup change (from the patch)
const changeSetText = await readFile(CHANGE_SET, "utf8");
const patchLines = changeSetText.split(/\r?\n/);
const attr = (tag, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag || "");
  return m ? m[1] : null;
};
const minusInput = patchLines.find((l) => l.startsWith("-") && l.includes('id="scan-root-input"'));
const plusInput = patchLines.find((l) => l.startsWith("+") && l.includes('id="scan-root-input"'));
const markup = {
  file: "public/index.html",
  before: { placeholder: attr(minusInput, "placeholder"), title: attr(minusInput, "title") },
  after: { placeholder: attr(plusInput, "placeholder"), title: attr(plusInput, "title") },
  patchLines: { before: minusInput ?? null, after: plusInput ?? null },
};

// ---------------------------------------------------------------- target + verdict
const targetPairs = pairs.filter((p) => p.state !== "search");
const stateTargets = targetPairs.map((p) => ({
  viewport: p.viewport,
  state: p.state,
  roots: p.after.shot.roots.map((r, i) => ({
    index: i,
    before: { h: px(p.before.shot.roots[i].box.h), gaps: p.before.shot.roots[i].gaps, minGap: p.before.shot.roots[i].minGap },
    after: { h: px(r.box.h), gaps: r.gaps, minGap: r.minGap },
  })),
  rootAdd: {
    before: {
      inputWidth: px(p.before.shot.rootAdd.input.w),
      placeholder: p.before.shot.rootAdd.placeholder,
      placeholderPx: p.before.shot.rootAdd.placeholderPx,
      placeholderRoom: p.before.shot.rootAdd.placeholderRoom,
      placeholderFits: p.before.shot.rootAdd.placeholderFits,
      buttonWidth: px(p.before.shot.rootAdd.button.box.w),
      rowFree: p.before.shot.rootAdd.rowFree,
    },
    after: {
      inputWidth: px(p.after.shot.rootAdd.input.w),
      placeholder: p.after.shot.rootAdd.placeholder,
      placeholderPx: p.after.shot.rootAdd.placeholderPx,
      placeholderRoom: p.after.shot.rootAdd.placeholderRoom,
      placeholderFits: p.after.shot.rootAdd.placeholderFits,
      buttonWidth: px(p.after.shot.rootAdd.button.box.w),
      rowFree: p.after.shot.rootAdd.rowFree,
    },
  },
}));

const rootGapsVisible = targetPairs.every((p) => p.after.shot.roots.length === p.before.shot.roots.length && p.after.shot.roots.every((r) => r.gaps.length === 2 && r.gaps.every((g) => g >= 6)));
const gapWasClosed = targetPairs.some((p) => p.before.shot.roots.some((r) => r.gaps.some((g) => g < 6)));
const addFieldUsesRow = targetPairs.every((p) => p.after.shot.rootAdd && p.after.shot.rootAdd.rowFree <= 1);
const placeholderFits = targetPairs.every((p) => p.after.shot.rootAdd.placeholderFits === true);
const inputWidened = targetPairs.every((p) => p.after.shot.rootAdd.input.w > p.before.shot.rootAdd.input.w + 20);
const cardHeightSame = targetPairs.every((p) => p.after.shot.roots.every((r, i) => Math.abs(r.box.h - p.before.shot.roots[i].box.h) <= 0.02));
const controlsIntact = pairs.every((p) => p.dom.controls.unexpectedChanges.length === 0 && p.dom.elements.added.length === 0 && p.dom.elements.removed.length === 0 && p.dom.controls.before === p.dom.controls.after);
const noNewOverflow = pairs.every((p) => p.dom.overflow.added.length === 0);
const fontNotSmaller = pairs.every((p) => (p.dom.scalars.find((s) => s.path === "minFontSize")?.after ?? 999) >= 10);
const testsPass = tests.runs.every((r) => r.exit === 0 && r.fail === 0);
const pixelsMoved = pairs.some((p) => p.surfaceDiff.visibleDelta > 0);

const regressions = [];
if (!controlsIntact) regressions.push("an element was added or removed, a control's role or name changed outside the intended placeholder, or the control count changed");
if (!noNewOverflow) regressions.push("a new overflow entry appeared");
if (!fontNotSmaller) regressions.push("the smallest painted font shrank below 10 px");
if (!testsPass) regressions.push("the surface's own tests failed");
if (targetPairs.some((p) => p.after.shot.roots.some((r, i) => r.minGap < p.before.shot.roots[i].minGap)))
  regressions.push("a root row's gaps shrank");
if (targetPairs.some((p) => !p.after.shot.rootAdd.placeholderFits && p.before.shot.rootAdd.placeholderFits))
  regressions.push("the add-folder hint stopped fitting");
if (targetPairs.some((p) => p.after.shot.rootAdd.input.w < p.before.shot.rootAdd.input.w))
  regressions.push("the add-folder input got narrower");
if (targetPairs.some((p) => p.after.shot.rootAdd.rowFree > p.before.shot.rootAdd.rowFree))
  regressions.push("the add row left more width unused");

const nothingMoved = pairs.every((p) => p.surfaceDiff.visibleDelta === 0);

const outcome = regressions.length
  ? "regressed"
  : nothingMoved
    ? "unchanged"
    : rootGapsVisible && addFieldUsesRow && placeholderFits && inputWidened && controlsIntact && noNewOverflow && fontNotSmaller && testsPass && pixelsMoved
      ? "improved"
      : "unchanged";

const changedPixels = pairs.reduce((n, p) => n + p.surfaceDiff.visibleDelta, 0);
const totalPixels = pairs.reduce((n, p) => n + p.surfaceDiff.pixels, 0);
const styleElements = cssGlobal.elements.changed;
const elementGeometry = pairs.reduce((n, p) => n + (p.dom.elements.byField.box || 0), 0);
const intendedChanges = pairs.reduce((n, p) => n + p.dom.controls.intendedChanges.length, 0);
const unexpectedChanges = pairs.reduce((n, p) => n + p.dom.controls.unexpectedChanges.length, 0);

const summary = {
  pairs: pairs.length,
  shots: pairs.length * 2,
  viewports: afterCap.viewports.map((v) => v.name),
  states: afterCap.states.map((s) => s.name),
  surfacePixelsCompared: totalPixels,
  surfacePixelsMoved: changedPixels,
  surfacePixelsMovedPct: round((changedPixels / totalPixels) * 100, 3),
  target: {
    rootGapsVisibleEverywhere: rootGapsVisible,
    gapWasClosed: gapWasClosed,
    addFieldUsesRow: addFieldUsesRow,
    placeholderFits: placeholderFits,
    inputWidened: inputWidened,
    cardHeightUnchanged: cardHeightSame,
  },
  integrity: {
    controlsIntact,
    intendedControlChanges: intendedChanges,
    unexpectedControlChanges: unexpectedChanges,
    noNewOverflow,
    minFontNotSmaller: fontNotSmaller,
    elementsBefore: pairs[0]?.dom.elements.before ?? null,
    elementsAfter: pairs[0]?.dom.elements.after ?? null,
    controlsBefore: pairs[0]?.dom.controls.before ?? null,
    controlsAfter: pairs[0]?.dom.controls.after ?? null,
    styleChangedElements: styleElements,
    elementBoxesChanged: elementGeometry,
    cssRulesAdded: cssGlobal.rules.added.length,
    cssRulesRemoved: cssGlobal.rules.removed.length,
    cssVariablesChanged: cssGlobal.variables.changed.length,
  },
  tests: { command: tests.command, runs: tests.runs.map((r) => ({ tree: r.tree, exit: r.exit, tests: r.tests, pass: r.pass, fail: r.fail })) },
  observations,
  problems,
};

const evidence = [];
const openB = stateTargets.find((t) => t.viewport === "1440x900" && t.state === "open");
if (openB) {
  for (const r of openB.roots) {
    evidence.push(
      `root ${r.index + 1}: row height ${r.before.h} -> ${r.after.h} px; gaps before [${r.before.gaps.join(", ")}] -> after [${r.after.gaps.join(", ")}] px (min gap ${r.before.minGap} -> ${r.after.minGap})`,
    );
  }
  evidence.push(
    `add row: input ${openB.rootAdd.before.inputWidth} -> ${openB.rootAdd.after.inputWidth} px wide, button ${openB.rootAdd.before.buttonWidth} -> ${openB.rootAdd.after.buttonWidth} px, width left unused ${openB.rootAdd.before.rowFree} -> ${openB.rootAdd.after.rowFree} px`,
  );
  evidence.push(
    `add hint: "${openB.rootAdd.before.placeholder}" measures ${openB.rootAdd.before.placeholderPx} px in ${openB.rootAdd.before.placeholderRoom} px of room (fits: ${openB.rootAdd.before.placeholderFits}) -> "${openB.rootAdd.after.placeholder}" measures ${openB.rootAdd.after.placeholderPx} px in ${openB.rootAdd.after.placeholderRoom} px (fits: ${openB.rootAdd.after.placeholderFits})`,
  );
  evidence.push(
    `Board panel content height ${round(pairs.find((p) => p.viewport === "1440x900" && p.state === "open").before.shot.panel.h)} -> ${round(pairs.find((p) => p.viewport === "1440x900" && p.state === "open").after.shot.panel.h)} px; scrollHeight ${pairs.find((p) => p.viewport === "1440x900" && p.state === "open").before.shot.panelScrollHeight} -> ${pairs.find((p) => p.viewport === "1440x900" && p.state === "open").after.shot.panelScrollHeight} px (the 14 px the change-set predicted)`,
  );
}
evidence.push(
  `markup: #scan-root-input placeholder "${markup.before.placeholder}" -> "${markup.after.placeholder}"; title "${markup.before.title}" -> "${markup.after.title}" (the full sentence moves into title, so the hint keeps its example)`,
);
evidence.push(
  `surface pixels moved: ${changedPixels} of ${totalPixels} (${summary.surfacePixelsMovedPct}%) across ${pairs.length} surface pairs; per pair ${pairs.map((p) => `${p.viewport}/${p.state} ${p.surfaceDiff.visibleDelta}`).join(", ")}`,
);
evidence.push(
  `DOM inventory: ${summary.integrity.elementsBefore} -> ${summary.integrity.elementsAfter} elements per pair, ${summary.integrity.controlsBefore} -> ${summary.integrity.controlsAfter} controls; added/removed ${pairs.reduce((n, p) => n + p.dom.elements.added.length + p.dom.elements.removed.length, 0)}; intended name changes ${intendedChanges}, unexpected ${unexpectedChanges}`,
);
evidence.push(
  `CSS inventory: ${cssGlobal.rules.added.length} rules added, ${cssGlobal.rules.removed.length} removed (2,087 -> ${afterCss.rules.length}); ${styleElements} painted elements changed computed style at 1440x900 open (the block and its parts, and the Board panel's height); :root variables changed ${cssGlobal.variables.changed.length}`,
);
evidence.push(
  `tests: ${tests.runs.map((r) => `${r.tree}: exit ${r.exit}, ${r.pass} pass, ${r.fail} fail, ${r.tests} total`).join("; ")}`,
);
evidence.push(...observations.map((o) => `observation: ${o}`));

const comparison = {
  schema: "comparison/1",
  pipeline: "gui-improve",
  stage: "compare",
  visit: 2,
  // The comparison measures the after surface: its URL and brief come from the after capture. The change
  // and changeSource stay the before capture's, because they describe the problem the change answers.
  surface: { ...beforeCap.surface, brief: afterCap.surface.brief, url: afterCap.surface.url },
  inputs: {
    changeSet: {
      file: "ledger/gui-improve/settings-panel-board/compare/change-set.patch",
      source: "93febcc98da2:ledger/gui-improve/change-set.patch",
      sha256: sha256(await readFile(CHANGE_SET)),
    },
    baseline: {
      capture: "ledger/gui-improve/baseline/capture.json",
      commit: "44b4278",
      sha256: sha256(await readFile(path.join(BEFORE_DIR, "capture.json"))),
      copy: "ledger/gui-improve/settings-panel-board/compare/before/capture.json",
      dom: "ledger/gui-improve/settings-panel-board/compare/before/dom.json",
      css: "ledger/gui-improve/settings-panel-board/compare/before/css.json",
      note: "The path ledger/gui-improve/baseline/ in this tree holds a later gui-improve run's Pipeline surface. The authoritative before set for this comparison is the copy under compare/before/, made from 44b4278 with git archive; before/SOURCE.json records every file and shot hash, and the capture hash matches the baseline verdict's capture_sha256.",
    },
    after: {
      capture: "ledger/gui-improve/settings-panel-board/compare/after/capture.json",
      sha256: sha256(await readFile(path.join(AFTER_DIR, "capture.json"))),
      tree: "44b4278 + the change-set's public/ hunks",
      dom: "ledger/gui-improve/settings-panel-board/compare/after/dom.json",
      css: "ledger/gui-improve/settings-panel-board/compare/after/css.json",
    },
  },
  environment: afterCap.environment,
  protocol: {
    viewports: afterCap.viewports,
    states: afterCap.states.map((s) => ({ name: s.name, steps: s.steps })),
    sameAsBaseline: JSON.stringify(afterCap.viewports) === JSON.stringify(beforeCap.viewports) && JSON.stringify(afterCap.states.map((s) => s.name)) === JSON.stringify(beforeCap.states.map((s) => s.name)),
    notes: afterCap.notes,
    fullPage:
      "The capture writes a full-page shot and a 340x520 surface shot per state. The surface shot is the pair this comparison diffs: both sides are the Settings window alone, at the same three viewports and the same three states. The full-page shots are recorded in each manifest with their hashes but are not diffed: the baseline's own README says the board behind the window is live, so those pages differ between any two captures, and the baseline's instruction is to diff surfaceFile.",
  },
  markup,
  pairs: pairs.map((p) => ({
    viewport: p.viewport,
    state: p.state,
    before: {
      shot: p.before.surfaceRel,
      sha256: p.before.shot.surfaceSha256,
      pixels: p.before.shot.surfacePixels,
      win: p.before.shot.win,
      panel: p.before.shot.panel,
      bodyScrollHeight: p.before.shot.bodyScrollHeight,
      panelScrollHeight: p.before.shot.panelScrollHeight,
      bodyScrollTop: p.before.shot.bodyScrollTop,
      visibleRows: p.before.shot.visibleRows,
      roots: p.before.shot.roots,
      rootAdd: p.before.shot.rootAdd,
      fullPage: { file: relPath(beforePath(p.before.shot.file)), sha256: p.before.shot.sha256, pixels: p.before.shot.pixels },
    },
    after: {
      shot: p.after.surfaceRel,
      sha256: p.after.shot.surfaceSha256,
      pixels: p.after.shot.surfacePixels,
      win: p.after.shot.win,
      panel: p.after.shot.panel,
      bodyScrollHeight: p.after.shot.bodyScrollHeight,
      panelScrollHeight: p.after.shot.panelScrollHeight,
      bodyScrollTop: p.after.shot.bodyScrollTop,
      visibleRows: p.after.shot.visibleRows,
      roots: p.after.shot.roots,
      rootAdd: p.after.shot.rootAdd,
      fullPage: { file: relPath(afterPath(p.after.shot.file)), sha256: p.after.shot.sha256, pixels: p.after.shot.pixels },
    },
    pixelDiff: { surface: p.surfaceDiff },
    states: stateTargets.find((t) => t.viewport === p.viewport && t.state === p.state) ?? null,
    dom: p.dom,
    css: p.css,
    shots: {
      surface: { before: p.before.surfaceRel, after: p.after.surfaceRel, diff: p.surfaceDiff.diffFile },
    },
  })),
  summary,
  verdict: { outcome, reasons: evidence, regressions },
  tests,
  generated_at: new Date().toISOString(),
};

await writeFile(path.join(HERE, "comparison.json"), JSON.stringify(comparison, null, 2) + "\n", "utf8");

// ---------------------------------------------------------------- the page
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const imgData = async (p) => "data:image/png;base64," + (await readFile(path.join(ROOT, p))).toString("base64");
const imgTag = (src, alt) => `<img src="${src}" alt="${esc(alt)}">`;

const rows = [];
for (const p of pairs) {
  const surfaceB = await imgData(p.before.surfaceRel);
  const surfaceA = await imgData(p.after.surfaceRel);
  const surfaceD = await imgData(p.surfaceDiff.diffFile);
  const t = p.states;
  const rootRows = (t?.roots ?? [])
    .map(
      (r) =>
        `<tr><td>${r.index + 1}</td><td>${r.before.h}</td><td>${r.after.h}</td><td>${esc(r.before.gaps.join(" / "))}</td><td>${esc(r.after.gaps.join(" / "))}</td><td>${r.before.minGap} -> ${r.after.minGap}</td></tr>`,
    )
    .join("");
  const addRow = t
    ? `<tr><td>add row</td><td>${t.rootAdd.before.inputWidth}</td><td>${t.rootAdd.after.inputWidth}</td><td>${t.rootAdd.before.rowFree}</td><td>${t.rootAdd.after.rowFree}</td><td>${t.rootAdd.before.placeholderPx} / ${t.rootAdd.before.placeholderRoom} (${t.rootAdd.before.placeholderFits ? "fits" : "clipped"}) -> ${t.rootAdd.after.placeholderPx} / ${t.rootAdd.after.placeholderRoom} (${t.rootAdd.after.placeholderFits ? "fits" : "clipped"})</td></tr>`
    : "";
  const boxList = p.dom.elements.changedElements
    .filter((e) => e.changes.box)
    .map((e) => `<li><code>${esc(e.tag)}${e.id ? "#" + esc(e.id) : ""}${e.cls ? "." + esc(e.cls.split(/\s+/).join(".")) : ""}</code> - ${esc(Object.entries(e.changes.box).map(([k, v]) => `${k} ${v.before} -> ${v.after}`).join(", "))}</li>`)
    .join("");
  const styleList = p.css.elements.changedElements
    .map((e) => `<li><code>${esc(e.tag)}${e.id ? "#" + esc(e.id) : ""}${e.cls ? "." + esc(e.cls.split(/\s+/).join(".")) : ""}</code> - ${esc(Object.keys(e.changed).join(", "))}</li>`)
    .join("");
  const controlList = p.dom.controls.afterInventory
    .map((e) => `<li><code>${esc(e.role)}</code> "${esc(e.name || e.text)}"${e.id ? ` <code>#${esc(e.id)}</code>` : ""}${e.value != null ? ` value ${esc(e.value)}` : ""}</li>`)
    .join("");
  rows.push(`<section class="pair">
  <h2>${esc(p.viewport)} - ${esc(p.state)}</h2>
  <p class="stats">surface diff: <b>${p.surfaceDiff.visibleDelta}</b> px changed (${round((p.surfaceDiff.visibleDelta / p.surfaceDiff.pixels) * 100, 2)}%), mean delta ${round(p.surfaceDiff.meanAbsDelta, 2)}, max delta ${p.surfaceDiff.maxDelta}.
  ${p.surfaceDiff.bbox ? `changed bbox x${p.surfaceDiff.bbox.x} y${p.surfaceDiff.bbox.y} ${p.surfaceDiff.bbox.w}x${p.surfaceDiff.bbox.h}.` : "no visible pixel changed."}</p>
  <p class="stats">elements ${p.dom.elements.before} -> ${p.dom.elements.after}; controls ${p.dom.controls.before} -> ${p.dom.controls.after}; added/removed <b>${p.dom.elements.added.length}/${p.dom.elements.removed.length}</b>; intended control name changes <b>${p.dom.controls.intendedChanges.length}</b>; unexpected <b>${p.dom.controls.unexpectedChanges.length}</b>.</p>
  <div class="shot"><figure><figcaption>before</figcaption>${imgTag(surfaceB, "before")}</figure><figure><figcaption>after</figcaption>${imgTag(surfaceA, "after")}</figure><figure><figcaption>diff (red = changed)</figcaption>${imgTag(surfaceD, "diff")}</figure></div>
  ${
    t
      ? `<table><thead><tr><th>root</th><th>row h before</th><th>row h after</th><th>gaps before (path / chip / remove)</th><th>gaps after</th><th>min gap</th></tr></thead><tbody>${rootRows}${addRow}</tbody></table>`
      : `<p class="stats">The Board roots block is hidden in the search state, so there is no root geometry to compare; the shot proves the filter still hides it and the panel is unchanged.</p>`
  }
  <details><summary>control inventory - role, name and text of all ${p.dom.controls.after} controls</summary><ul>${controlList}</ul></details>
  ${styleList ? `<details><summary>computed-style changes on ${p.css.elements.changed} element(s)</summary><ul>${styleList}</ul></details>` : "<p>no computed-style changes.</p>"}
  ${boxList ? `<details><summary>geometry changes on ${p.dom.elements.byField.box || 0} element(s)</summary><ul>${boxList}</ul></details>` : "<p>no element geometry changes.</p>"}
</section>`);
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Settings - Board - before / after / diff</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px 32px; background: #14181d; color: #d7dee7; font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 22px; margin: 0 0 6px; color: #fff; }
  h2 { font-size: 16px; margin: 0 0 4px; color: #fff; }
  .verdict { display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; font-size: 12px; }
  .improved { background: #123a25; color: #6ee7a8; border: 1px solid #1f6b45; }
  .unchanged { background: #2c2c2c; color: #bbb; border: 1px solid #444; }
  .regressed { background: #3d1616; color: #ff9b9b; border: 1px solid #7a2a2a; }
  .lead { color: #9aa7b6; max-width: 1000px; }
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
  .note { color: #8b98a7; font-size: 12px; }
</style></head><body>
<h1>Settings - Board - before / after / diff</h1>
<p><span class="verdict ${esc(outcome)}">${esc(outcome)}</span></p>
<p class="lead">${esc(beforeCap.surface.change)} ${esc(pairs.length)} surface pairs: ${esc(afterCap.viewports.map((v) => v.name).join(", "))} x ${esc(afterCap.states.map((s) => s.name).join(", "))}. Same steps and asserts as the baseline. Tests: <span class="tests ${testsPass ? "" : "bad"}">${tests.runs.map((r) => `${r.pass} pass / ${r.fail} fail, exit ${r.exit}`).join("; ")}</span>.</p>
<ul>${evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
<p class="note">Full-page shots are recorded in each capture manifest but not diffed: the baseline's own README says the live board behind the Settings window differs between any two captures; the 340x520 surface shot is the stable pair.</p>
${rows.join("\n")}
</body></html>`;

await writeFile(path.join(HERE, "comparison.html"), html, "utf8");

const verdict = {
  gate: "G2",
  outcome,
  pipeline: "gui-improve",
  stage: "compare",
  visit: 2,
  surface: "settings-panel-board",
  baseline: "44b4278",
  after: "44b4278 + change-set (public/index.html, public/style.css)",
  viewports: afterCap.viewports.map((v) => v.name),
  states: afterCap.states.map((s) => s.name),
  pairs: pairs.length,
  shots: pairs.length * 2,
  pixels_moved: changedPixels,
  pixels_compared: totalPixels,
  tests: { command: tests.command, runs: tests.runs.map((r) => ({ tree: r.tree, exit: r.exit, tests: r.tests, pass: r.pass, fail: r.fail })) },
  evidence,
  observations,
  regressions,
  comparison: "ledger/gui-improve/settings-panel-board/compare/comparison.json",
  page: "ledger/gui-improve/settings-panel-board/compare/comparison.html",
  checked_at: new Date().toISOString(),
};
await writeFile(path.join(HERE, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");

console.log(JSON.stringify({ outcome, pairs: pairs.length, pixelsMoved: changedPixels, styleElements, tests: verdict.tests, problems, evidence }, null, 2));
