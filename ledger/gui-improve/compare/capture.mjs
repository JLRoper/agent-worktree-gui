// gui-improve compare capture - the Board's Unattached agents section, headless Chromium.
//
// The baseline's own script, re-pointed at this stage tree: writes
// ledger/gui-improve/compare/{capture.json,dom.json,css.json,style.css,shots/*.png}. It boots its own
// throwaway panel instance through tools/panel-testkit.mjs (the real server.js of THIS tree), builds the
// same git fixture with two worktrees, and seeds the same two unattached cards. Nothing in public/,
// lib/ or server.js is written by this script.
//
// Run from the repo root:
//   PLAYWRIGHT_BROWSERS_PATH="$LOCALAPPDATA/ms-playwright" NODE_PATH="$APPDATA/npm/node_modules" \
//   node ledger/gui-improve/compare/capture.mjs
//
// PANEL_BASE overrides the panel URL: with it set the script does NOT boot anything and shoots that instance
// (which must be serving this tree, or environment.servedFiles will say matchesTree false).
// The protocol (viewports, states, steps, fixture, assertions) is the baseline's, unchanged.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, git, slash, startPanel } from "../../../tools/panel-testkit.mjs";
import { withBrowser } from "../../../tools/browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUT = HERE;
const FIXED_BASE = process.env.PANEL_BASE ? process.env.PANEL_BASE.replace(/\/?$/, "/") : null;

const VIEWPORTS = [{ name: "1440x900", width: 1440, height: 900 }];

const STATES = [
  {
    name: "open",
    steps: [
      "Fresh browser context at 1440x900, device scale factor 1 (no localStorage, so every section is at its default).",
      "goto the panel base URL.",
      "wait for #agents and for #jobs to hold two .job[data-thread] cards (the seeded unattached store).",
      "assert #agents is not collapsed, #jobs is painted, no .attach-row is visible, and every card draws a .job-cwd line.",
      "wait two animation frames, then a further 300 ms for the last paint.",
    ],
  },
  {
    name: "expanded",
    steps: [
      "Reach the open state exactly as above.",
      "click [data-attach-toggle=\"fixture-tree-worker\"] (the card whose cwd is a worktree the board has not read).",
      "wait for that card's .attach-row to lose [hidden] and for its select to hold options.",
      "assert the attach row is painted, the select is populated, and the Attach press carries its disabled state as measured.",
      "wait two animation frames, then a further 300 ms for the last paint.",
    ],
  },
  {
    name: "collapsed",
    steps: [
      "Reach the expanded state exactly as above.",
      "click .project-head[data-toggle-fixed=\"agents\"] (the section's own bar, not one of its buttons).",
      "wait for #agents to carry .fixed-collapsed and for #jobs to report display:none and no painted box.",
      "assert the bar is still painted and its label still names the section.",
      "wait two animation frames, then a further 300 ms for the last paint.",
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
const SLASH = (p) => String(p).replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Throwaway root for the fixture and the sandbox store. WAG_SCRATCH lets a run keep them under a named
// folder; the OS temp dir is the default so the committed script carries no machine path.
const SCRATCH = process.env.WAG_SCRATCH || os.tmpdir();
let PANEL = null;

// Every path the page shows under the sandbox is written as "<sandbox>/..." in the ledger: the folder is a
// throwaway on one machine, and a committed record must not carry a drive letter a reader cannot open. The
// measurements (boxes, fonts, option wording) are otherwise untouched: only the prefix of a string changes.
function desandbox(value, sandbox) {
  const forms = [SLASH(sandbox), String(sandbox)];
  const swap = (s) => forms.reduce((acc, f) => acc.split(f).join("<sandbox>"), s);
  if (typeof value === "string") return swap(value);
  if (Array.isArray(value)) return value.map((v) => desandbox(v, sandbox));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, desandbox(v, sandbox)]));
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// The fixture: two scanned repos (one with a worktree) and one repo OUTSIDE the scan root whose
// worktree is the card's directory. Rows the board knows: alpha main, alpha feat-one, gamma main.
// The missing row is the point: tonight's card was in a tree the board had not read yet.
// ---------------------------------------------------------------------------------------------
async function buildFixture(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, "outside"), { recursive: true });
  const repos = {
    alpha: path.join(dir, "alpha"),
    gamma: path.join(dir, "gamma"),
    beta: path.join(dir, "outside", "beta"),
  };
  for (const [name, repo] of Object.entries(repos)) {
    await mkdir(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, "README.md"), `# ${name}\n\nfixture repository for the unattached-agents baseline\n`, "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", `fixture: ${name}`);
  }
  git(repos.alpha, "worktree", "add", "-q", path.join(repos.alpha, ".worktrees", "feat-one"), "-b", "feat-one");
  git(repos.beta, "worktree", "add", "-q", path.join(repos.beta, ".worktrees", "feat-long-tree-name"), "-b", "feat-long-tree-name");
  return {
    root: SLASH(dir),
    projects: { alpha: SLASH(repos.alpha), gamma: SLASH(repos.gamma), beta: SLASH(repos.beta) },
    scanned: [SLASH(path.join(repos.alpha, ".worktrees", "feat-one")), SLASH(path.join(repos.gamma))],
    unreadWorktree: SLASH(path.join(repos.beta, ".worktrees", "feat-long-tree-name")),
  };
}

function jobsFixture(fixture) {
  const at = "2026-11-09T03:10:00.000Z";
  const card = (id, thread, title, cwd, prompt) => ({
    id,
    thread,
    turn: 1,
    reply: false,
    existing: false,
    revived: false,
    assistant: false,
    prompt,
    cwd,
    worktree: null,
    worktreePath: null,
    ownerPath: null,
    ownerPending: false,
    projectPath: null,
    clarifyUnavailable: false,
    runId: null,
    approvalDone: null,
    questionDone: null,
    sessionId: thread,
    status: "done",
    exitCode: 0,
    fatal: null,
    title,
    label: title,
    startedAt: at,
    endedAt: at,
    lines: [],
  });
  return {
    savedAt: at,
    jobs: [
      card(
        "11111111",
        "fixture-tree-worker",
        "unread-tree worker",
        fixture.unreadWorktree,
        "Tighten the attach control on this card.",
      ),
      card(
        "22222222",
        "fixture-row-worker",
        "read-tree worker",
        fixture.scanned[0],
        "Move the cwd line above the console.",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Page-side readers. Self-contained: serialised by page.evaluate.
// ---------------------------------------------------------------------------------------------
function collectInventory({ styleProps }) {
  const clean = (s, n = 400) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, bottom: b.bottom, left: b.left, right: b.right };
  };
  const painted = (el) => {
    if (!el || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (tag === "a") return "link";
    if (tag === "h1" || tag === "h2" || tag === "h3") return "heading";
    return null;
  };
  const nameOf = (el) => {
    const al = el.getAttribute("aria-label");
    if (al && clean(al)) return { name: clean(al), source: "aria-label" };
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "a") return { name: clean(el.textContent), source: "text" };
    if (el.getAttribute("title") && !clean(el.textContent)) return { name: clean(el.getAttribute("title")), source: "title" };
    return { name: clean(el.textContent), source: "text" };
  };

  const section = document.getElementById("agents");
  const head = section ? section.querySelector(".project-head") : null;
  const jobs = document.getElementById("jobs");
  const sectionBox = rect(section);
  const headBox = rect(head);
  const jobsBox = rect(jobs);

  const elements = [];
  if (section) {
    for (const el of [section, ...section.querySelectorAll("*")]) {
      if (!painted(el)) continue;
      const cs = getComputedStyle(el);
      const nm = nameOf(el);
      elements.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: el.getAttribute("class") || null,
        role: roleOf(el),
        name: nm.name,
        nameSource: nm.source,
        text: clean(el.textContent),
        box: rect(el),
        fontSize: cs.fontSize,
        display: cs.display,
        hidden: !!el.hidden,
        disabled: !!el.disabled,
        value: el.tagName === "SELECT" ? String(el.value).slice(0, 240) : null,
        ariaExpanded: el.getAttribute("aria-expanded"),
        title: el.getAttribute("title") || null,
      });
    }
  }

  const cards = section
    ? [...section.querySelectorAll(".job[data-thread]")].map((card) => {
        const thread = card.dataset.thread;
        const cwd = card.querySelector(".job-cwd");
        const cwdPath = card.querySelector(".job-cwd .cwd-path");
        const meta = card.querySelector(".job-head > span.mono.dim");
        const toggle = card.querySelector("[data-attach-toggle]");
        const row = card.querySelector("[data-attach-row]");
        const sel = row ? row.querySelector("select[data-attach-path]") : null;
        const go = row ? row.querySelector("[data-attach-go]") : null;
        const cpBox = rect(cwdPath);
        return {
          thread,
          collapsed: card.classList.contains("collapsed"),
          box: rect(card),
          headBox: rect(card.querySelector(".job-head")),
          title: clean(card.querySelector(".job-title")?.textContent) || null,
          pill: clean(card.querySelector(".job-head .pill")?.textContent) || null,
          metaText: meta ? clean(meta.textContent) : null,
          metaTitle: meta?.getAttribute("title") || null,
          cwd: cwd
            ? {
                box: rect(cwd),
                label: clean(cwd.querySelector(".cwd-label")?.textContent) || null,
                pathText: clean(cwdPath?.textContent) || null,
                pathTitle: cwdPath?.getAttribute("title") || null,
                pathBox: cpBox,
                pathClientWidth: cwdPath ? cwdPath.clientWidth : null,
                pathScrollWidth: cwdPath ? cwdPath.scrollWidth : null,
                pathTruncated: cwdPath ? cwdPath.scrollWidth > cwdPath.clientWidth + 1 : null,
                lineTitle: cwd.getAttribute("title") || null,
                rowChip: clean(cwd.querySelector(".cwd-row")?.textContent) || null,
                runChip: clean(cwd.querySelector(".cwd-run")?.textContent) || null,
                name: clean(cwd.querySelector(".thread-name")?.textContent) || null,
              }
            : null,
          attachToggle: toggle
            ? { text: clean(toggle.textContent), box: rect(toggle), title: toggle.getAttribute("title") || null }
            : null,
          attachRow: row
            ? {
                hidden: !!row.hidden,
                box: rect(row),
                missing: sel?.dataset?.attachMissing || null,
                selectedIndex: sel ? sel.selectedIndex : null,
                selectedText: sel && sel.selectedOptions[0] ? clean(sel.selectedOptions[0].textContent) : null,
                options: sel
                  ? [...sel.options].map((o) => ({ value: o.value, text: clean(o.textContent), selected: o.selected, disabled: o.disabled }))
                  : [],
                go: go ? { text: clean(go.textContent), disabled: !!go.disabled, box: rect(go) } : null,
              }
            : null,
        };
      })
    : [];

  const overflow = [];
  if (sectionBox) {
    for (const el of section ? section.querySelectorAll("*") : []) {
      if (!painted(el)) continue;
      const b = rect(el);
      if (b.w === 0 && b.h === 0) continue;
      if (b.right > sectionBox.right + 0.5) {
        overflow.push({ kind: "past-section-right", tag: el.tagName.toLowerCase(), cls: el.getAttribute("class"), box: b });
      }
    }
    for (const p of section ? section.querySelectorAll(".cwd-path") : []) {
      if (!painted(p)) continue;
      if (p.scrollWidth > p.clientWidth + 1) {
        overflow.push({ kind: "cwd-path-ellipsized", text: clean(p.textContent), scrollWidth: p.scrollWidth, clientWidth: p.clientWidth });
      }
    }
  }
  const textEls = elements.filter((e) => e.text && e.box.w > 0 && e.box.h > 0);
  return {
    viewport: { width: innerWidth, height: innerHeight },
    url: location.href,
    scrollY: document.scrollingElement ? document.scrollingElement.scrollTop : window.scrollY,
    docHeight: document.documentElement.scrollHeight,
    section: section
      ? {
          box: sectionBox,
          collapsed: section.classList.contains("collapsed") || section.classList.contains("fixed-collapsed"),
          headBox,
          headText: clean(head?.textContent),
          label: clean(head?.querySelector("h2")?.textContent) || null,
          pathHint: clean(head?.querySelector(".path")?.textContent) || null,
          chipText: clean(head?.querySelector(".chips")?.textContent) || null,
        }
      : null,
    jobs: jobsBox ? { box: jobsBox, display: getComputedStyle(jobs).display, hidden: !!jobs.hidden, scrollHeight: jobs.scrollHeight, childCount: jobs.children.length } : null,
    cardCount: cards.length,
    cards,
    elementCount: elements.length,
    minFontSize: textEls.length ? Math.min(...textEls.map((e) => parseFloat(e.fontSize) || 999)) : null,
    overflow,
    elements,
  };
}

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
  const rules = [];
  const sheets = [];
  const atRules = [];
  const walk = (list, sheetIndex, media) => {
    for (const rule of list) {
      if (rule.type === CSSRule.STYLE_RULE) {
        rules.push({ sheet: sheetIndex, media: media || null, selector: rule.selectorText, style: rule.style.cssText });
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
  const section = document.getElementById("agents") || document;
  for (const el of [section, ...section.querySelectorAll("*")]) {
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

// ---------------------------------------------------------------------------------------------
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

async function main() {
  // A fixed sandbox name, not mkdtemp: the fixture paths are written into the manifest and into the picker's
  // missing-row message, and a compare run must read the same paths as this baseline. Removed and rebuilt per run.
  const sandbox = path.join(SCRATCH, "wag-unattached-baseline");
  await rm(sandbox, { recursive: true, force: true });
  const fixtureDir = path.join(sandbox, "fixture");
  const fixture = await buildFixture(fixtureDir);
  const jobsFile = path.join(sandbox, "logs", "jobs.json");
  await mkdir(path.dirname(jobsFile), { recursive: true });
  await writeFile(jobsFile, JSON.stringify(jobsFixture(fixture), null, 2) + "\n", "utf8");

  let panel = null;
  let base = FIXED_BASE;
  if (!base) {
    const port = await freePort();
    panel = await startPanel({
      dir: sandbox,
      port,
      keep: true,
      config: {
        scanRoots: [fixture.root],
        threads: 2,
        worktreeSeconds: 60,
        midSeconds: 60,
        dormantSeconds: 60,
        slowSeconds: 60,
        refreshSeconds: 60,
        fetchSeconds: 60,
        jobsFile,
        matrix: null,
      },
    });
    PANEL = panel;
    base = panel.base + "/";
  }

  // The board is ready when the two scanned projects and their worktree rows are in /api/state.
  const stateDeadline = Date.now() + 120_000;
  let state = null;
  const rowsOf = (s) => (Array.isArray(s?.projects) ? s.projects : []).flatMap((p) => (p.worktrees || []).map((w) => ({ ...w, project: p.name })));
  for (;;) {
    const r = await fetch(new URL("api/state", base));
    state = await r.json().catch(() => null);
    const rows = rowsOf(state);
    const names = rows.map((x) => x.name);
    if (names.includes("feat-one") && names.includes("gamma")) break;
    if (Date.now() > stateDeadline) {
      throw new Error(`board never read the fixture: rows ${JSON.stringify(names)}`);
    }
    await sleep(400);
  }
  const rowsSeen = rowsOf(state).map((r) => ({ project: r.project, name: r.name, path: SLASH(r.path), branch: r.branch || null }));

  const run = await withBrowser(async ({ page, browser }) => {
    const shots = [];
    const dom = { schema: "dom-inventory/1", surface: "#agents (Unattached agents section) on the board", per_viewport: {} };
    const css = { schema: "css-inventory/1", surface: "#agents", per_viewport: {} };
    const version = await (await fetch(new URL("api/config", base))).json();
    const browserVersion = await browser.version();
    const vp = VIEWPORTS[0];
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message || e)));
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push(m.text());
    });
    dom.per_viewport[vp.name] = {};
    css.per_viewport[vp.name] = {};

    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("#agents", { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll("#jobs .job[data-thread]").length === 2, null, { timeout: 30000 });
    // The store and the socket both repaint #jobs wholesale once the snapshot lands; a click on the first
    // paint lands on a node the next repaint throws away. Read until two consecutive reads agree.
    const sectionKey = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#jobs .job[data-thread]")]
          .map((c) => `${c.dataset.thread}|${c.querySelector(".cwd-path")?.textContent || ""}|${c.className}`)
          .join("~"),
      );
    let prevKey = null;
    for (let i = 0; i < 10; i++) {
      const key = await sectionKey();
      if (prevKey === key) break;
      prevKey = key;
      await page.waitForTimeout(400);
    }
    // The socket's first snapshot lands after the store's own paint; a repaint after that throws away a
    // JS-set attach row. Let the first full sync pass before anything is pressed.
    await page.waitForTimeout(2500);

    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const readInventory = () => page.evaluate(collectInventory, { styleProps: STYLE_PROPS });
    const readCss = () => page.evaluate(collectCss, { styleProps: STYLE_PROPS });

    const assertOpen = async () => {
      const ok = await page.evaluate(() => {
        const s = document.getElementById("agents");
        const j = document.getElementById("jobs");
        const cards = [...document.querySelectorAll("#jobs .job[data-thread]")];
        return {
          section: !!s,
          collapsed: !!s && (s.classList.contains("collapsed") || s.classList.contains("fixed-collapsed")),
          jobsPainted: !!j && j.getClientRects().length > 0,
          cards: cards.length,
          cwdLines: cards.filter((c) => c.querySelector(".job-cwd .cwd-path")).length,
          attachRowsVisible: [...document.querySelectorAll("#jobs .attach-row")].filter((r) => !r.hidden && r.getClientRects().length).length,
        };
      });
      if (!ok.section || ok.collapsed || !ok.jobsPainted) throw new Error(`open state not reached at ${vp.name}: ${JSON.stringify(ok)}`);
      if (ok.cards !== 2 || ok.cwdLines !== 2) throw new Error(`open state at ${vp.name}: ${ok.cards} cards, ${ok.cwdLines} cwd lines (expected 2/2)`);
      if (ok.attachRowsVisible !== 0) throw new Error(`open state at ${vp.name}: ${ok.attachRowsVisible} attach rows already visible`);
      return ok;
    };

    const attachState = () =>
      page.evaluate(() => {
        const row = document.querySelector('[data-attach-row="fixture-tree-worker"]');
        const sel = row ? row.querySelector("select[data-attach-path]") : null;
        return { ok: !!row && !row.hidden && !!sel && sel.options.length > 0, hidden: !!row?.hidden, options: sel ? sel.options.length : 0 };
      });
    const ensureAttachOpen = async () => {
      for (let i = 0; i < 6; i++) {
        const st = await attachState();
        if (st.ok) return st;
        await page.click('[data-attach-toggle="fixture-tree-worker"]');
        await page.waitForTimeout(400);
      }
      return attachState();
    };

    const snapshot = async (stateName) => {
      const baseName = `${vp.name}-${stateName}`;
      const pageFile = `ledger/gui-improve/compare/shots/${baseName}.png`;
      const surfaceFile = `ledger/gui-improve/compare/shots/${baseName}-surface.png`;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (stateName === "expanded") await ensureAttachOpen();
        await settle();
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, "shots", `${baseName}.png`), fullPage: true, animations: "disabled", caret: "hide" });
        await page.locator("#agents").screenshot({ path: path.join(OUT, "shots", `${baseName}-surface.png`), animations: "disabled", caret: "hide" });
        const inv = await readInventory();
        // A repaint between the press and this read rebuilds the card with the row hidden again: retry the
        // whole shot rather than record an empty expand.
        if (stateName === "expanded") {
          const row = inv.cards.find((c) => c.thread === "fixture-tree-worker")?.attachRow;
          if (!row || row.hidden) continue;
        }
        const pageBuf = await readFile(path.join(OUT, "shots", `${baseName}.png`));
        const surfaceBuf = await readFile(path.join(OUT, "shots", `${baseName}-surface.png`));
        const cssInv = await readCss();
        const steps = STATES.find((s) => s.name === stateName).steps;
        dom.per_viewport[vp.name][stateName] = { viewport: { name: vp.name, width: vp.width, height: vp.height }, state: stateName, steps, ...inv };
        css.per_viewport[vp.name][stateName] = {
          viewport: { name: vp.name, width: vp.width, height: vp.height },
          state: stateName,
          elementCount: cssInv.elementCount,
          elements: cssInv.elements,
        };
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
          steps,
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
          section: inv.section,
          jobs: inv.jobs,
          cardCount: inv.cardCount,
          cards: inv.cards,
          overflow: inv.overflow,
          errors: [...errors],
        });
        return inv;
      }
      throw new Error(`snapshot ${stateName} at ${vp.name}: the state did not hold for three attempts`);
    };

    // open
    await assertOpen();
    await snapshot("open");

    // expanded: the card whose cwd is a worktree the board has not read. A repaint can replace the card
    // between the click and the read, so the press is repeated until the row and its options are on the page.
    const opened = await ensureAttachOpen();
    if (!opened.ok) throw new Error(`expanded state at ${vp.name}: ${JSON.stringify(opened)}`);
    const expandedCheck = await page.evaluate(() => {
      const row = document.querySelector('[data-attach-row="fixture-tree-worker"]');
      const sel = row?.querySelector("select[data-attach-path]");
      const go = row?.querySelector("[data-attach-go]");
      return {
        hidden: !!row?.hidden,
        painted: !!row && row.getClientRects().length > 0,
        options: sel ? [...sel.options].map((o) => ({ text: o.textContent.trim(), value: o.value, disabled: o.disabled })) : [],
        selectedText: sel?.selectedOptions?.[0]?.textContent?.trim() || null,
        missing: sel?.dataset?.attachMissing || null,
        goDisabled: !!go?.disabled,
      };
    });
    if (expandedCheck.hidden || !expandedCheck.painted || expandedCheck.options.length < 1) {
      throw new Error(`expanded state at ${vp.name}: ${JSON.stringify(expandedCheck)}`);
    }
    await snapshot("expanded");

    // collapsed: the section's own bar.
    await page.click('.project-head[data-toggle-fixed="agents"]');
    await page.waitForFunction(
      () => {
        const s = document.getElementById("agents");
        const j = document.getElementById("jobs");
        return !!s && s.classList.contains("fixed-collapsed") && !!j && j.getClientRects().length === 0;
      },
      null,
      { timeout: 10000 },
    );
    await snapshot("collapsed");

    return { shots, dom, css, version, browserVersion, rowsSeen, expandedCheck };
  }, { viewport: { width: 1440, height: 900 }, headless: true });

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

  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const domOut = desandbox(run.dom, sandbox);
  const cssOut = desandbox(run.css, sandbox);
  await writeFile(path.join(OUT, "dom.json"), JSON.stringify(domOut, null, 2) + "\n", "utf8");
  await writeFile(path.join(OUT, "css.json"), JSON.stringify(cssOut, null, 2) + "\n", "utf8");
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
    const res = await fetch(new URL(url, base));
    const buf = Buffer.from(await res.arrayBuffer());
    if (name === "public/index.html") {
      const text = buf.toString("utf8");
      panelBuild = /<meta name="panel-build" content="([^"]+)"/.exec(text)?.[1] || null;
    }
    served[name] = { status: res.status, sha256: sha256(buf), bytes: buf.length, matchesTree: sha256(buf) === treeFiles[name].sha256 };
  }

  const open = run.dom.per_viewport[VIEWPORTS[0].name].open;
  const expanded = run.dom.per_viewport[VIEWPORTS[0].name].expanded;
  const collapsed = run.dom.per_viewport[VIEWPORTS[0].name].collapsed;
  const cardOf = (inv, thread) => inv.cards.find((c) => c.thread === thread) || null;

  const capture = {
    schema: "capture/1",
    pipeline: "gui-improve",
    stage: "compare",
    visit: 1,
    surface: {
      brief: "The Board's Unattached agents section (#agents) at " + base,
      briefText:
        "Baseline stage of the gui-improve walk on the unattached-agents panel. Tonight a worker whose cwd was a worktree appeared in that section with no way to see which tree it belonged to. The round's brief: make the section say where an unattached card's directory actually is and offer the right tree.",
      url: base,
      selector: "#agents",
      cardSelector: "#jobs .job[data-thread]",
      board: "the main board (no Settings window open); the section sits under the New agent card, above #projects",
      change:
        "The Unattached agents section must say where an unattached card's directory actually is, and its attach action must offer the tree that directory belongs to.",
      changeSource:
        "Measured in this baseline, on a card whose cwd is a worktree the board has not read: the head's meta line reads 'no worktree' while the card's own cwd line names a .worktrees path; the only visible tree fact is the 10.5 px dim tail of that line (full path only in its title attribute); and the attach picker opens on a disabled placeholder naming only the tree's last path segment, with Attach disabled and no option carrying the card's tree. The section head's hint also asserts the card has no worktree of its own.",
      reproduce:
        "This directory's capture.mjs boots its own sandbox of THIS tree (the stage tree with the implement stage's change-set applied) and the baseline's fixture board (two scanned repos, one worktree each for the unread repo, two seeded unattached cards), then shoots the same three states the baseline shot. public/ is read per request by the panel; lib/ needs a restart.",
      scope: "The whole #agents section: its .project-head bar and #jobs with every card. The rest of the board is in the full-page shot only.",
    },
    round: {
      branch: "wtgui/round-c-how-a-round-names-its-trees-5b3b85",
      base: "99f2bd777a2a24d1aedd903e9c4b24a4d9520c36",
      baseParent: "origin/main",
      note:
        "This stage tree is the round parent (132354c1, two docs commits on 99f2bd7) and its public/, lib/ and server.js are byte-identical to the baseline's base 99f2bd7: git diff --stat 99f2bd7 HEAD -- public lib server.js is empty. The change-set (d813b435, ledger/gui-improve/change-set.patch) was applied to this tree with git apply -p1, so the after shots are the baseline's build plus that patch and nothing else.",
    },
    changeSet: {
      file: "ledger/gui-improve/change-set.patch",
      commit: "d813b435",
      tree: "the-implement-stage-of-the-unattached-61851d",
      bytes: 14474,
      note:
        "The implement stage's artefact, read at the named commit and applied to this tree as a patch. It is not re-committed here: this branch records the comparison and the patched product files, and the patch itself stays on the implement stage's commit.",
    },
    supersedes: {
      path: "ledger/gui-improve/compare/capture.json",
      previousSurface: "the task pipeline window's card (gui-improve, an earlier round)",
      note:
        "The pipeline's compare artefact paths are fixed, so this round replaces capture.json, comparison.json, comparison.html and verdict.json in this directory. The earlier round's pipeline shots (shots/*-pipeline*.png), pipeline-bundle.json and style.css are left untouched; they are not this stage's measurements.",
    },
    fixture: {
      root: fixture.root,
      scanRoots: [fixture.root],
      projects: fixture.projects,
      rows: run.rowsSeen,
      cards: jobsFixture(fixture).jobs.map((j) => ({ thread: j.thread, title: j.title, cwd: j.cwd, ownerPath: j.ownerPath })),
      story:
        "alpha and gamma are scanned (alpha has the worktree feat-one). beta lives outside every scan root and has the worktree feat-long-tree-name, so the card pointed at it is a worker whose cwd is a worktree the board has no row for: tonight's shape.",
      scaleFactor: "Both counts are 1: the sandbox config's scanRoots and jobsFile are the only inputs.",
    },
    environment: {
      browser: `Playwright Chromium ${run.browserVersion} (headless)`,
      deviceScaleFactor: 1,
      serverVersion: run.version.version,
      serverUrl: base,
      panelBuild,
      sandbox: {
        dir: SLASH(sandbox),
        jobsFile: SLASH(jobsFile),
        jobsRestored: 2,
        config: { scanRoots: [fixture.root], projects: [], threads: 2, jobsFile: SLASH(jobsFile) },
        note: "A throwaway instance of this tree on a free port with its own store. The reader's own panel was not touched.",
      },
      servedNote:
        "public/index.html is rewritten by the panel for cache-busting (stylesheet links carry ?v=<panel-build> and a meta panel-build tag is added), so its hash differs from the tree by that stamp and nothing else; app.js and style.css are byte-identical to this tree.",
      servedFiles: served,
      treeFiles,
    },
    viewports: VIEWPORTS.map((v) => ({ name: v.name, width: v.width, height: v.height })),
    states: STATES.map((s) => ({ name: s.name, steps: s.steps })),
    shots: run.shots,
    measurements: {
      sectionOpen: {
        box: open.section.box,
        headBox: open.section.headBox,
        label: open.section.label,
        pathHint: open.section.pathHint,
        collapsed: open.section.collapsed,
        jobsBox: open.jobs.box,
        jobsScrollHeight: open.jobs.scrollHeight,
        cards: open.cardCount,
        paintedElements: open.elementCount,
        minFontSize: open.minFontSize,
      },
      cardUnreadTree: cardOf(open, "fixture-tree-worker"),
      cardReadTree: cardOf(open, "fixture-row-worker"),
      attachPicker: cardOf(expanded, "fixture-tree-worker")?.attachRow || null,
      attachPickerAssert: run.expandedCheck,
      collapsed: {
        section: collapsed.section,
        jobs: collapsed.jobs,
        cardCount: collapsed.cardCount,
        paintedElements: collapsed.elementCount,
      },
      overflow: { open: open.overflow, expanded: expanded.overflow, collapsed: collapsed.overflow },
    },
    target: {
      problem:
        "An unattached card whose cwd is a worktree the board has not read gives the reader no way to see which tree it is in, and its attach action offers every other tree instead.",
      measured: {
        sectionHint: open.section.pathHint,
        headMetaOfTreeCard: cardOf(open, "fixture-tree-worker")?.metaText || null,
        cwdPathVisible: cardOf(open, "fixture-tree-worker")?.cwd?.pathText || null,
        cwdPathWidthPx: cardOf(open, "fixture-tree-worker")?.cwd?.pathBox?.w ?? null,
        cwdLineFontPx: 10.5,
        cwdPathTruncated: cardOf(open, "fixture-tree-worker")?.cwd?.pathTruncated ?? null,
        fullPathOnlyInTitle: Boolean(cardOf(open, "fixture-tree-worker")?.cwd?.lineTitle),
        rowChipShown: Boolean(cardOf(open, "fixture-tree-worker")?.cwd?.rowChip),
        pickerOptionCount: (cardOf(expanded, "fixture-tree-worker")?.attachRow?.options || []).length,
        pickerOffersCardTree: (cardOf(expanded, "fixture-tree-worker")?.attachRow?.options || []).some((o) => /feat-long-tree-name/.test(o.value)),
        pickerSelectedText: cardOf(expanded, "fixture-tree-worker")?.attachRow?.selectedText || null,
        attachPressDisabled: Boolean(cardOf(expanded, "fixture-tree-worker")?.attachRow?.go?.disabled),
      },
      ask:
        "The section must say where an unattached card's directory actually is (the project and the tree, in visible text, not only a 10.5 px path tail and a title attribute) and its attach action must offer the tree that directory belongs to, or say plainly that the board has no row for it and what would make one.",
    },
    inventory: {
      dom: {
        file: "ledger/gui-improve/compare/dom.json",
        sha256: sha256(domBuf),
        bytes: domBuf.length,
        elements: Object.values(run.dom.per_viewport).reduce((n, v) => n + Object.values(v).reduce((m, s) => m + s.elementCount, 0), 0),
      },
      css: {
        file: "ledger/gui-improve/compare/css.json",
        sha256: sha256(cssBuf),
        bytes: cssBuf.length,
        elements: Object.values(run.css.per_viewport).reduce((n, v) => n + Object.values(v).reduce((m, s) => m + s.elementCount, 0), 0),
      },
      stylesheet: {
        file: "ledger/gui-improve/compare/style.css",
        sha256: sha256(styleBuf),
        bytes: styleBuf.length,
        servedSha256: served["public/style.css"].sha256,
        matchesTree: served["public/style.css"].matchesTree,
      },
      rules: run.css.rules.length,
      sheets: run.css.sheets,
    },
    notes: {
      shotPair:
        "shots[*].file is a full-page shot of the whole board; shots[*].surfaceFile is the #agents section alone and is the stable pair to diff. The section depends only on the seeded store and the fixture board, so the pair repeats across captures of the same build.",
      relativeText:
        "The seeded cards carry fixed startedAt/endedAt instants and no lastActiveAt, so no relative age or duration text is drawn on them; a compare run still masks any duration text the console may grow.",
      phantomRows:
        "The board draws the whole fixture, but only the two seeded cards are in #jobs; nothing else in the section is live.",
    },
    incomplete,
    recorded_at: new Date().toISOString(),
  };
  await writeFile(path.join(OUT, "capture.json"), JSON.stringify(desandbox(capture, sandbox), null, 2) + "\n", "utf8");

  return {
    shots: capture.shots.length,
    states: capture.states.map((s) => s.name),
    fixtureRows: run.rowsSeen,
    served,
    metrics: {
      sectionOpen: { box: open.section.box, cards: open.cardCount, elements: open.elementCount },
      cardUnreadTree: {
        metaText: cardOf(open, "fixture-tree-worker")?.metaText,
        cwdPath: cardOf(open, "fixture-tree-worker")?.cwd?.pathText,
        cwdLineTitle: cardOf(open, "fixture-tree-worker")?.cwd?.lineTitle,
      },
      attachPicker: capture.measurements.attachPicker,
      collapsed: { section: collapsed.section.box, jobs: collapsed.jobs },
    },
    incomplete,
    files: {
      capture: { bytes: (await stat(path.join(OUT, "capture.json"))).size },
      dom: capture.inventory.dom,
      css: capture.inventory.css,
    },
    sandbox: SLASH(sandbox),
  };
}

let result;
try {
  result = await main();
} finally {
  // The sandbox is kept (keep: true) for a re-run; the panel process is stopped here, never left listening.
  if (PANEL) await PANEL.stop();
}
console.log(JSON.stringify(result, null, 2));
