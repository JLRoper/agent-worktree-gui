// The console's fonts, measured through the browser's OWN platform fonts, and the console's row spacing.
// HARNESS: LIVE GATE - a seeded fixture, so it runs anywhere Playwright is installed.
//
//   node tools/verify-console-fonts.mjs                     # the gate: every entry measured, every pair diffed
//   node tools/verify-console-fonts.mjs --shots <dir>       # where the captures go
//   node tools/verify-console-fonts.mjs --json <file>       # keep the raw ledger
//   node tools/verify-console-fonts.mjs --html <file>       # the self-contained report (images inlined)
//   node tools/verify-console-fonts.mjs --suite "<counts>" --version "<from -> to>"
//
// WHY. Two lists decide what the panel's text is drawn in - UI_FONTS (the page's labels) and TERM_FONTS (the console) -
// and both were written as STACKS, so an entry naming a face this machine has never had draws the next one instead.
// Ten console entries were nine ways of asking for Consolas, and the reader had no way to tell: every one of them was
// accepted, saved under wtgui.termFont and drawn in exactly the console they already had. The lists also carried no
// statement of what each entry RESOLVES to, so "JetBrains Mono" was a promise the box could not keep. This harness
// answers both questions with the browser's own answer rather than a font-name lookup:
//
//   CSS.getPlatformFontsForNode  says which faces ACTUALLY drew the glyphs of a node - the ground truth a CSS stack
//                                cannot state, because the stack is a request and this is the paint;
//   a pixel diff of the SAME text       says whether two entries are the same picture, which family names alone do not
//                                settle (Segoe UI Variable and Segoe UI are different families that draw differently,
//                                while two aliases of one file name draw the same).
//
// WHAT IS DRIVEN (nothing synthetic reaches the page): a throwaway panel of its own (tools/panel-testkit.mjs - spare
// port, own PANEL_CONFIG / HERMES_HOME / jobs.json, API_SERVER_KEY empty), no gateway, the assistant's own rules off,
// and ONE thread whose newest turn is drawn OPEN so its console is the transcript a reader reads a reply in:
//
//   console row one / two / three      three physical lines: the vertical gap between two of them is the row spacing
//   read_file · lib/jobs.js            a tool call row
//   patched the guard / 412 lines      the output under it
//   the long one: wrap wrap wrap ...   one row that wraps, so a leading change moves a height a reader can count
//
// WHAT IT ASSERTS:
//   (1) EVERY ENTRY IS A FACE THIS BOX HAS, and the label says which: the entry's declared resolution (the option text
//       after " -> ") is the family CSS.getPlatformFontsForNode reports for the painted node, case for case;
//   (2) NO TWO ENTRIES ARE THE SAME PICTURE: within a list, no pair has the same platform-font readout AND 0 differing
//       pixels - that is the duplicate the lists used to be full of;
//   (3) AN ENTRY THAT CHANGES NOTHING IS NOT AN ENTRY: every console entry draws the console differently from the
//       default one (pixels), and every UI entry draws the UI label differently from the default one;
//   (4) THE ROW SPACING IS ONE VARIABLE, and every console row follows it: at 1.2, 1.5 and 2.4 the console's computed
//       line-height is --con-row-space x --term-size, the distance between two lines of console text is that
//       line-height, a wrapped row grows by whole lines, the reasoning block and the tool rows move with the prose,
//       and the PROMPT BOX's own padding never moves at all;
//   (5) DEFAULTS ARE TODAY'S LOOK: with no key stored the console draws 1.5 (17.25px at 11.5px), the slider sits there,
//       and one press of `use defaults` puts a changed value back;
//   (6) the choice is SAVED with the other wtgui.* settings, and RE-APPLIED on the next load of the page;
//   (7) nothing pressed here raised a page error.
//
// Exit codes: 0 held; 1 a check failed; 2 the run did not measure what it claims (no Playwright, no console, no CDP).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun, openSettingsGroup, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-console-fonts")));
const JSON_OUT = opt("--json");
const LEDGER_OUT = opt("--ledger");
const FROM = opt("--from");
const HTML_OUT = opt("--html");
const SUITE = opt("--suite");
const VERSION = opt("--version");
const THREAD = "panel-assistant";

// The fixture. Three physical lines, a tool call, its output, and one long wrapping row - the four shapes a console row
// comes in, so "every console row follows the spacing" is measured on all of them and not on the prose alone. The first
// row also carries the sequences a coding font ligates (-> => <= !=), because that is where two faces that look alike
// on plain words - Cascadia Code and Cascadia Mono - are actually different pictures.
const TRANSCRIPT = [
  "a != b -> c => d <= e, 100 != 200",
  "console row one",
  "console row two",
  "console row three",
  "read_file · lib/jobs.js",
  "patched the guard, 412 lines",
  "the long row: " + "wrap ".repeat(80).trim(),
];
// The console's own numbers, before any setting: 11.5px of text at a 1.5 line-height.
const TERM_PX = 11.5;
const NOW = { mult: 1.5, line: TERM_PX * 1.5 };
// The clip every font strip is taken at, in CSS pixels: ONE fixed rect, so two strips are always comparable and a
// picture of one font can be laid beside another's.
const TERM_CLIP = { width: 640, height: 96 };
const UI_CLIP = { width: 320, height: 64 };

let checks = 0;
let failures = 0;
const out = {
  tree: TREE,
  shots: SHOTS,
  fonts: { ui: [], term: [] },
  spacing: [],
  duplicated: [],
  checks: [],
  errors: [],
  verdict: null,
};
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  out.checks.push({ ok, label, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);

// ---- the fixture: one thread, one open turn ---------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-console-fonts-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
const now = Date.now();
const seedPath = path.join(TREE, ".worktrees", "console-fonts-fixture-0001").replace(/\\/g, "/");
const message = TRANSCRIPT.join("\n");
const job = {
  id: "confonts1",
  thread: THREAD,
  turn: 1,
  prompt: "measure the console's fonts and its row spacing",
  status: "done",
  exitCode: 0,
  startedAt: new Date(now - 60_000).toISOString(),
  endedAt: new Date(now - 30_000).toISOString(),
  durationMs: 30_000,
  finalMessage: message,
  cwd: seedPath,
  ownerPath: seedPath,
  worktreePath: seedPath,
  worktree: "console-fonts-fixture-0001",
  lines: TRANSCRIPT.map((text, i) => ({ kind: /read_file/.test(text) ? "tool" : /patched the guard/.test(text) ? "tool-out" : "text", text, lid: i + 1, at: now - 31_000 + i })),
};
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs: [job] }, null, 1));

const { freePort, startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  root: TREE,
  config: {
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    discoverSeconds: 3600,
    assistant: { enabled: false },
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
  },
});

// ---- the pid and the profile this run owns, so they can be quoted and proved reaped -----------------------------
// Playwright's Browser does not expose a pid, but Chromium's own SystemInfo domain does: the browser process and the
// profile directory its command line names are read from the browser being driven, not from a guess about image names.
const alivePid = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The two lists AS THE BRANCH'S BASE COMMIT HAD THEM: the entries this work removed can then be measured in the same
// run and the report can show what each one actually drew, instead of asking a reader to believe a claim about the
// past. Read out of git rather than copied into this file, so the "before" cannot drift from what shipped.
function baseLists() {
  const git = (args) => execFileSync("git", args, { cwd: TREE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  let base = null;
  for (const ref of ["origin/main", "main", "HEAD"]) {
    try {
      base = String(git(["merge-base", "HEAD", ref]) || "").trim() || null;
      if (base) break;
    } catch {
      /* no such ref here: try the next */
    }
  }
  if (!base) return null;
  const raw = git(["show", `${base}:public/app.js`]);
  const block = (name) => {
    const at = raw.indexOf(`const ${name} = [`);
    if (at < 0) return [];
    const end = raw.indexOf("\n];", at);
    return [...raw.slice(at, end).matchAll(/\{ id: "([\w-]+)", label: "[^"]*", stack: (['"])(.*?)\2/g)].map((m) => ({ id: m[1], stack: m[3] }));
  };
  const ui = block("UI_FONTS");
  const term = block("TERM_FONTS");
  return ui.length && term.length ? { base, ui, term } : null;
}

// RENDER ONLY: a ledger from a run already made, re-rendered into the page with the gate's numbers filled in. No
// browser, no panel, nothing started - so the page a reader opens is the run that was actually measured, and the
// suite's counts go into it without a second measurement disagreeing with the first.
if (FROM) {
  const ledger = JSON.parse(readFileSync(FROM, "utf8"));
  const page = { ...ledger, suite: SUITE || ledger.suite || null, version: VERSION || ledger.version || null };
  if (HTML_OUT) writeFileSync(HTML_OUT, reportHtml(page));
  console.log(`rendered ${HTML_OUT || "(no --html)"} from ${FROM}`);
  console.log(`  ${page.verdict ? `${page.verdict.held}/${page.verdict.checks} checks held, ${page.verdict.failures} failed` : "no verdict"}; suite ${page.suite || "(not recorded)"}; version ${page.version || "(not recorded)"}`);
  process.exit(0);
}

const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log(notRun("the console fonts and row spacing", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)"));
  process.exit(2);
}

// The page's own two lists, read off the selects a reader picks from: the option's value is the id and its text is the
// label, with the measured face after an arrow wherever the label is a description rather than a family name.
const readLists = (page) =>
  page.evaluate(() => {
    const list = (sel) => [...document.querySelectorAll(`${sel} option`)].map((o) => {
      const text = String(o.textContent || "").trim();
      const at = text.lastIndexOf(" -> ");
      const head = at < 0 ? text : text.slice(0, at);
      return { id: o.value, optionText: text, label: head, arrow: at < 0 ? "" : text.slice(at + 4), head: head.split(" (")[0].trim() };
    });
    return { ui: list("#font-select"), term: list("#term-select") };
  });

// The console rows the spacing is measured on: every console line the reader can see, with its own line box.
const readSpacing = (page, thread) =>
  page.evaluate((thread) => {
    const job = document.querySelector(`#assistant .job[data-thread="${thread}"]`);
    const turns = job ? [...job.querySelectorAll(".turn")] : [];
    const turn = turns[turns.length - 1];
    const pre = turn ? turn.querySelector("pre.job-out") : null;
    if (!pre) return null;
    const rows = [...pre.querySelectorAll(".jl, .jl-tool, .jl-tool-out")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top * 100) / 100, bottom: Math.round(r.bottom * 100) / 100, left: Math.round(r.left * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 };
    };
    const lineOf = (el) => Math.round((parseFloat(getComputedStyle(el).lineHeight) || 0) * 100) / 100;
    // Two lines of console text, one above the other in the same piece: the gap between them is the line box, and the
    // rows carry no margin of their own (a piece boundary has `jl-sep` and is measured separately).
    const pairs = [];
    for (let i = 1; i < rows.length; i += 1) {
      const a = rows[i - 1];
      const b = rows[i];
      if (a.parentElement !== b.parentElement) continue;
      const mt = parseFloat(getComputedStyle(b).marginTop) || 0;
      if (mt !== 0) continue;
      pairs.push({ text: String(b.textContent || "").slice(0, 24), delta: Math.round((box(b).top - box(a).top) * 100) / 100 });
    }
    const wrapped = rows.find((el) => String(el.textContent || "").startsWith("the long row:"));
    const reply = document.querySelector(`#assistant .job[data-thread="${thread}"] .reply-box`);
    const replyCs = reply ? getComputedStyle(reply) : null;
    const css = getComputedStyle(pre);
    return {
      found: true,
      pre: box(pre),
      line: lineOf(pre),
      font: css.fontFamily,
      size: css.fontSize,
      vars: { rowSpace: getComputedStyle(document.documentElement).getPropertyValue("--con-row-space").trim(), termSize: getComputedStyle(document.documentElement).getPropertyValue("--term-size").trim() },
      rows: rows.slice(0, 8).map((el) => ({ cls: el.className, ...box(el), line: lineOf(el), marginTop: Math.round((parseFloat(getComputedStyle(el).marginTop) || 0) * 100) / 100 })),
      pairs: pairs.slice(0, 6),
      wrapped: wrapped ? { rows: Math.round(box(wrapped).height / lineOf(wrapped)), height: box(wrapped).height, line: lineOf(wrapped) } : null,
      reply: replyCs ? { padding: [replyCs.paddingTop, replyCs.paddingRight, replyCs.paddingBottom, replyCs.paddingLeft].join(" "), font: replyCs.fontSize } : null,
      input: (() => {
        const el = document.getElementById("con-row-space");
        if (!el) return null;
        return { value: el.value, min: el.min, max: el.max, step: el.step, type: el.type, readout: String((document.getElementById("con-row-space-px") || {}).textContent || "").trim() };
      })(),
      preview: (() => {
        const el = document.getElementById("con-row-preview");
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { line: Math.round((parseFloat(cs.lineHeight) || 0) * 100) / 100, height: Math.round(el.getBoundingClientRect().height * 100) / 100, font: cs.fontSize };
      })(),
      store: (() => {
        try {
          return localStorage.getItem("wtgui.conRowSpace");
        } catch {
          return null;
        }
      })(),
    };
  }, thread);

const alive = [];
out.reaped = null;
try {
  console.log(`console fonts + row spacing gate on ${TREE}`);
  console.log(`  sandbox: ${panel.base} - one seeded turn, seven console rows, no gateway - shots ${SHOTS}`);
  mkdirSync(SHOTS, { recursive: true });

  await withBrowser(
    async ({ context, page, pageErrors, browser }) => {
      await page.addInitScript(() => {
        try {
          localStorage.setItem("wm.assistantOpen", "1");
        } catch {
          /* a browser with storage off still draws the rail on its default */
        }
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`#assistant .job[data-thread="${THREAD}"] .turn pre.job-out .jl`, { timeout: 45_000 });
      await page.waitForTimeout(700);

      // The Chromium this launch started, and the profile directory its own command line names - asked of the browser
      // itself, so the pid quoted in the report is the process that drew these pixels.
      const bcdp = await browser.newBrowserCDPSession();
      const sysinfo = await bcdp.send("SystemInfo.getProcessInfo").catch(() => ({ processInfo: [] }));
      const cmdline = await bcdp.send("Browser.getBrowserCommandLine").catch(() => ({ arguments: [] }));
      const all = (sysinfo.processInfo || []).map((p) => ({ type: String(p.type || ""), pid: Number(p.id) })).filter((p) => p.pid > 0);
      const profileArg = (cmdline.arguments || []).find((a) => String(a).startsWith("--user-data-dir="));
      out.browser = {
        pids: all.map((p) => p.pid),
        browserPid: (all.find((p) => p.type === "browser") || {}).pid || null,
        processes: all.length,
        profile: profileArg ? String(profileArg).replace("--user-data-dir=", "").replace(/^"|"$/g, "") : null,
      };

      // ---- the browser's own answer to "which face drew this" ------------------------------------------------
      const cdp = await context.newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");

      const nodeFor = async (selector) => {
        const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: false });
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        return nodeId || 0;
      };
      // The platform fonts of one node: every face that drew a glyph in it, with how many glyphs each drew. This is
      // the paint, not the request - the only honest answer to "what does this entry resolve to".
      const platformFonts = async (selector) => {
        const nodeId = await nodeFor(selector);
        if (!nodeId) return { error: `no node for ${selector}`, fonts: [] };
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        return {
          fonts: (fonts || []).map((f) => ({ family: String(f.familyName || ""), glyphs: Number(f.glyphCount) || 0, custom: Boolean(f.isCustomFont) })).sort((a, b) => b.glyphs - a.glyphs),
        };
      };

      const rectOf = (selector) =>
        page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return null;
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        }, selector);

      // One strip of pixels at a FIXED size, so two strips can be laid beside each other and diffed.
      const strip = async (name, rect, size) => {
        const clip = {
          x: Math.max(0, Math.round(rect.x + 2)),
          y: Math.max(0, Math.round(rect.y - 2)),
          width: size.width,
          height: size.height,
        };
        const buf = await page.screenshot({ clip, type: "png" });
        const file = path.join(SHOTS, `${name}.png`);
        writeFileSync(file, buf);
        return { file, name, b64: buf.toString("base64") };
      };

      // Two pictures of the same text, compared pixel by pixel in the page itself (no image library on this box):
      // how many pixels differ, and by how much at most.
      const diff = (aB64, bB64) =>
        page.evaluate(
          async ({ a, b }) => {
            const load = (src) =>
              new Promise((res, rej) => {
                const i = new Image();
                i.onload = () => res(i);
                i.onerror = () => rej(new Error("image decode failed"));
                i.src = `data:image/png;base64,${src}`;
              });
            const [ia, ib] = await Promise.all([load(a), load(b)]);
            if (ia.width !== ib.width || ia.height !== ib.height) return { differing: -1, total: 0, maxDelta: 255, sizeMismatch: true };
            const c = document.createElement("canvas");
            c.width = ia.width;
            c.height = ia.height;
            const g = c.getContext("2d", { willReadFrequently: true });
            g.drawImage(ia, 0, 0);
            const da = g.getImageData(0, 0, c.width, c.height).data;
            g.clearRect(0, 0, c.width, c.height);
            g.drawImage(ib, 0, 0);
            const db = g.getImageData(0, 0, c.width, c.height).data;
            let differing = 0;
            let maxDelta = 0;
            for (let i = 0; i < da.length; i += 4) {
              const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
              if (d > 0) differing += 1;
              if (d > maxDelta) maxDelta = d;
            }
            return { differing, total: c.width * c.height, maxDelta, sizeMismatch: false };
          },
          { a: aB64, b: bB64 },
        );

      const lists = await readLists(page);
      check(lists.term.length >= 2, "both font lists are on the page, with a default in each", `ui ${lists.ui.length}, term ${lists.term.length}`);
      check(lists.ui.some((f) => f.id === "default") && lists.term.some((f) => f.id === "default"), "the console and the page each keep a `default` entry - the id the store falls back to");

      // ---- (1) the console list, measured on a console LINE ------------------------------------------------
      // CSS.getPlatformFontsForNode reports the faces that painted a node's OWN text, so the node has to be the line
      // that holds the glyphs, not the console box around it (a box's own text is empty and it reports nothing). One
      // line is picked once and marked: the ligature row where it is on the page, otherwise the longest line, so the
      // same text is measured under every entry and the strips are comparable.
      const shape = await page.evaluate(() => {
        const pre = document.querySelector("pre.job-out");
        if (!pre) return null;
        return [...pre.children].slice(0, 8).map((el) => ({ tag: el.tagName.toLowerCase(), cls: el.className, text: String(el.textContent || "").slice(0, 40), h: Math.round(el.getBoundingClientRect().height * 10) / 10 }));
      });
      note(`console rows: ${JSON.stringify(shape)}`);
      const probe = await page.evaluate(() => {
        const pre = document.querySelector("pre.job-out");
        if (!pre) return null;
        const lines = [...pre.querySelectorAll(".jl, .jl-text, .md-para, .tgrp-head")].filter((el) => el.children.length === 0 && String(el.textContent || "").trim().length > 3 && el.getBoundingClientRect().height > 0);
        const lig = lines.find((el) => /=>/.test(String(el.textContent || "")));
        const pick = lig || lines.sort((a, b) => String(b.textContent || "").length - String(a.textContent || "").length)[0];
        if (!pick) return null;
        pick.id = "font-probe-line";
        const r = pick.getBoundingClientRect();
        return { text: String(pick.textContent || "").slice(0, 70), cls: pick.className, lines: lines.length, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
      });
      const termNode = probe ? "#font-probe-line" : "pre.job-out";
      const termRect = probe ? probe.rect : await rectOf(termNode);
      check(Boolean(probe), "the console carries a line of its own text to measure every font on", probe ? `${probe.lines} lines, measuring "${probe.text}" (${probe.cls})` : "no line found");
      if (!termRect) {
        check(false, "the console draws a line of text to measure the fonts on");
        return;
      }
      out.probe = probe ? { text: probe.text, cls: probe.cls, lines: probe.lines } : null;
      const termOnTop = await page.evaluate(
        ({ sel, r }) => {
          const el = document.elementFromPoint(r.x + 6, r.y + 6);
          const host = document.querySelector(sel);
          return Boolean(el && host && (el === host || host.contains(el)));
        },
        { sel: termNode, r: termRect },
      );
      check(termOnTop, "the strip photographs the console line that was measured", probe ? probe.text.slice(0, 40) : termNode);
      for (const entry of lists.term) {
        const applied = await page.evaluate((id) => {
          const api = window.WMApp && window.WMApp.settings;
          if (!api || typeof api.applyFont !== "function") return null;
          api.applyFont("term", id, { save: false });
          const pre = document.querySelector("pre.job-out");
          return pre ? { family: getComputedStyle(pre).fontFamily, varTerm: getComputedStyle(document.documentElement).getPropertyValue("--term").trim() } : null;
        }, entry.id);
        await page.waitForTimeout(60);
        if (!applied) {
          check(false, "the page's own applyFont is reachable", entry.id);
          break;
        }
        const painted = await platformFonts(termNode);
        const shot = await strip(`term-${entry.id}`, termRect, TERM_CLIP);
        out.fonts.term.push({ ...entry, applied, painted: painted.fonts, error: painted.error || null, strip: shot.file, b64: shot.b64 });
      }

      // ---- (2) the UI list, measured on a UI label ---------------------------------------------------------
      await openSettingsGroup(page, "display");
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const api = window.WMApp && window.WMApp.settings;
        if (api && typeof api.applyFont === "function") api.applyFont("ui", "default", { save: false });
        // The preview sits low in a long Display tab, and the drawer clips its own content: bring the label the fonts
        // are measured on into the drawer's visible area, or the strip below photographs the board behind it.
        const el = document.getElementById("font-preview");
        if (el) el.scrollIntoView({ block: "center" });
      });
      await page.waitForTimeout(250);
      const uiRect = await rectOf("#font-preview");
      if (!uiRect) {
        check(false, "the Display tab draws the panel-font preview a UI label can be measured on");
        return;
      }
      for (const entry of lists.ui) {
        const applied = await page.evaluate((id) => {
          const api = window.WMApp && window.WMApp.settings;
          if (!api || typeof api.applyFont !== "function") return null;
          api.applyFont("ui", id, { save: false });
          const el = document.getElementById("font-preview");
          return el ? { family: getComputedStyle(el).fontFamily, varUi: getComputedStyle(document.documentElement).getPropertyValue("--ui").trim(), text: String(el.textContent || "").trim() } : null;
        }, entry.id);
        await page.waitForTimeout(60);
        if (!applied) {
          check(false, "the page's own applyFont is reachable for the panel list", entry.id);
          break;
        }
        const here = (await rectOf("#font-preview")) || uiRect;
        const painted = await platformFonts("#font-preview");
        // The pixels in the strip have to be the label that was measured, not whatever the drawer is clipped over.
        const onTop = await page.evaluate(
          ({ sel, r }) => {
            const el = document.elementFromPoint(r.x + 6, r.y + 6);
            const host = document.querySelector(sel);
            return Boolean(el && host && (el === host || host.contains(el)));
          },
          { sel: "#font-preview", r: here },
        );
        const shot = await strip(`ui-${entry.id}`, here, UI_CLIP);
        check(onTop, `ui ${entry.id}: the strip photographs the label that was measured`, applied.text.slice(0, 40));
        out.fonts.ui.push({ ...entry, applied, painted: painted.fonts, error: painted.error || null, strip: shot.file, b64: shot.b64 });
      }
      // Back to the page's own font, so the spacing pass measures the console a reader actually has.
      await page.evaluate(() => {
        const api = window.WMApp && window.WMApp.settings;
        if (api && typeof api.applyFont === "function") api.applyFont("term", "default", { save: false });
        if (api && typeof api.applyFont === "function") api.applyFont("ui", "default", { save: false });
      });
      // The drawer is a fixed panel over the console's own column, so which font can be photographed depends on it:
      // the panel label needs the drawer open, the console needs it shut. One toggle, used on both sides.
      const drawer = async (open) => {
        const isOpen = await page.evaluate(() => {
          const p = document.getElementById("settings");
          return Boolean(p) && !p.classList.contains("hidden") && getComputedStyle(p).display !== "none";
        });
        if (open === isOpen) return;
        if (open) await openSettingsGroup(page, "display");
        else {
          await page.click("#btn-settings-close").catch(() => {});
          await page.waitForSelector("#settings.hidden", { timeout: 10_000 }).catch(() => {});
        }
        await page.waitForTimeout(250);
      };

      // ---- (1b) THE ENTRIES THIS BRANCH REMOVED, measured the same way ---------------------------------------
      // Every one of them has to come out as the SAME picture as the entry that replaced it - that is the finding the
      // audit acted on, and it is checked rather than asserted: if a removed entry turns out to have drawn something of
      // its own, this fails and the list was cut too deep.
      //
      // The old entry is drawn from the stack it shipped (the base commit's, read out of git), written where applyFont
      // writes - the variable AND, for the panel font, the preview's own inline family, because that inline style is
      // what the preview actually reads. The replacement is then drawn through the page's own applyFont at the SAME
      // rect, back to back, so the two strips are the same pixels of the same page whatever the scroll did meanwhile.
      const retiredMap = await page.evaluate(() => JSON.parse(JSON.stringify(FONT_RETIRED)));
      const before = baseLists();
      out.retired = { base: before ? before.base.slice(0, 8) : null, ui: [], term: [] };
      if (before) {
        for (const kind of ["ui", "term"]) {
          const liveIds = new Set(out.fonts[kind].map((e) => e.id));
          const node = kind === "term" ? termNode : "#font-preview";
          const size = kind === "term" ? TERM_CLIP : UI_CLIP;
          await drawer(kind === "ui");
          if (kind === "ui") {
            await page.evaluate(() => {
              const el = document.getElementById("font-preview");
              if (el) el.scrollIntoView({ block: "center" });
            });
            await page.waitForTimeout(200);
          }
          for (const old of before[kind]) {
            if (liveIds.has(old.id)) continue;
            const owner = String((retiredMap[kind] || {})[old.id] || "default");
            const applied = await page.evaluate(
              ({ k, stack }) => {
                const css = typeof withEmojiFallback === "function" ? withEmojiFallback(stack) : stack;
                document.documentElement.style.setProperty(k === "term" ? "--term" : "--ui", css);
                if (k === "ui") {
                  const p = document.getElementById("font-preview");
                  if (p) p.style.fontFamily = stack;
                }
                return css;
              },
              { k: kind, stack: old.stack },
            );
            await page.waitForTimeout(80);
            const rect = await rectOf(node);
            if (!rect) {
              check(false, `${kind} "${old.id}": the node to photograph is on the page`, node);
              continue;
            }
            const oldPainted = await platformFonts(node);
            const oldShot = await strip(`old-${kind}-${old.id}`, rect, size);
            // The replacement, through the page's own applier, on the same rect.
            await page.evaluate(
              ({ k, id }) => {
                const api = window.WMApp && window.WMApp.settings;
                if (api && typeof api.applyFont === "function") api.applyFont(k, id, { save: false });
              },
              { k: kind, id: owner },
            );
            await page.waitForTimeout(80);
            const ownerPainted = await platformFonts(node);
            const ownerShot = await strip(`now-${kind}-${owner}`, rect, size);
            const d = await diff(ownerShot.b64, oldShot.b64);
            const faces = oldPainted.fonts.map((f) => f.family).join("+");
            const ownerFaces = ownerPainted.fonts.map((f) => f.family).join("+");
            out.retired[kind].push({ id: old.id, stack: applied, painted: oldPainted.fonts, owner, ownerFaces, differing: d.differing, strip: oldShot.file, b64: oldShot.b64 });
            check(
              Boolean(faces) && faces === ownerFaces && d.differing === 0,
              `${kind} "${old.id}" drew the same picture as "${owner}" - which is why it is gone`,
              `old stack drew ${faces || "nothing"}, "${owner}" draws ${ownerFaces || "nothing"}, ${d.differing} px apart`,
            );
          }
        }
        // Back to the page's own two fonts for the spacing pass, and the drawer shut so the console is in view.
        await drawer(false);
        await page.evaluate(() => {
          const api = window.WMApp && window.WMApp.settings;
          if (api && typeof api.applyFont === "function") {
            api.applyFont("term", "default", { save: false });
            api.applyFont("ui", "default", { save: false });
          }
        });
        await page.waitForTimeout(120);
      } else {
        note("git could not be read here, so the removed entries were not re-drawn");
      }

      // ---- (3) EVERY ENTRY NAMES THE FACE IT DRAWS, AND NO TWO DRAW THE SAME PICTURE -----------------------
      const uiDefault = out.fonts.ui.find((e) => e.id === "default");
      for (const kind of ["ui", "term"]) {
        const entries = out.fonts[kind];
        if (!entries.length) {
          check(false, `the ${kind} list was measured`);
          continue;
        }
        for (const entry of entries) {
          const families = entry.painted.map((f) => f.family);
          const primary = families[0] || "";
          const said = entry.arrow || entry.head;
          check(Boolean(primary), `${kind} ${entry.id}: the browser reports the face that drew it`, families.length ? `${primary} (${entry.painted[0].glyphs} glyphs)` : "NO PLATFORM FONTS - the node drew nothing");
          if (kind === "term" && entry.id === "panel") {
            // This entry names no face of its own: it follows whatever the panel font is set to, so the claim is
            // about that relationship and not about a family.
            const uiPrimary = uiDefault && uiDefault.painted[0] ? uiDefault.painted[0].family : "";
            check(Boolean(primary) && primary.toLowerCase() === uiPrimary.toLowerCase(), "term panel: draws whatever the panel font draws", `console ${primary}, panel ${uiPrimary}`);
          } else {
            check(Boolean(primary) && primary.toLowerCase() === said.toLowerCase(), `${kind} ${entry.id}: the label names the face it draws`, `the picker says "${entry.optionText}", the paint says "${families.join(", ")}"`);
          }
          // The stack reached the variable the stylesheet reads: the computed family of the node is the entry's stack.
          check(Boolean(entry.applied && (kind === "term" ? entry.applied.varTerm : entry.applied.varUi)), `${kind} ${entry.id}: the stack is written to the variable it belongs to`, kind === "term" ? (entry.applied.varTerm || "").slice(0, 48) : (entry.applied.varUi || "").slice(0, 48));
        }
        // Pairwise: same platform-font readout AND the same pixels is a duplicate, whatever the names say.
        for (let i = 0; i < entries.length; i += 1) {
          for (let j = i + 1; j < entries.length; j += 1) {
            const a = entries[i];
            const b = entries[j];
            const sameFaces = a.painted.map((f) => f.family.toLowerCase()).join("|") === b.painted.map((f) => f.family.toLowerCase()).join("|");
            const d = await diff(a.b64, b.b64);
            const identical = sameFaces && d.differing === 0;
            if (identical) out.duplicated.push({ kind, a: a.id, b: b.id, faces: a.painted.map((f) => f.family).join(", ") });
            check(!identical, `${kind} ${a.id} vs ${b.id}: draws a different picture`, `differing ${d.differing}/${d.total} px, max delta ${d.maxDelta}, faces ${a.painted.map((f) => f.family).join("+")} vs ${b.painted.map((f) => f.family).join("+")}`);
            a.diffs = a.diffs || {};
            a.diffs[b.id] = d.differing;
          }
        }
        // One entry that draws what the default draws is an entry that changes nothing.
        const base = entries.find((e) => e.id === "default");
        if (base) {
          for (const entry of entries) {
            if (entry.id === "default") continue;
            const d = await diff(base.b64, entry.b64);
            entry.vsDefault = d.differing;
            check(d.differing > 0, `${kind} ${entry.id}: changes what the reader sees`, `${d.differing}/${d.total} px differ from the default`);
          }
        }
        // Every strip is a picture a reader can open: written, non-empty, and named after its entry.
        const missing = entries.filter((e) => !existsSync(e.strip));
        check(missing.length === 0, `${kind}: every surviving entry has its own capture beside its readout`, `${entries.length} strips, ${missing.length} missing`);
      }

      // ---- (4) THE ROW SPACING, at its minimum, its default and its maximum --------------------------------
      const readNow = () => readSpacing(page, THREAD);
      const setRow = async (value) =>
        page.evaluate((v) => {
          const el = document.getElementById("con-row-space");
          if (!el) return false;
          el.value = String(v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return el.value === String(v);
        }, value);

      let base = await readNow();
      check(Boolean(base), "the console draws the seeded transcript");
      if (!base) return;
      out.spacing.push({ name: "default-unset", ...base });
      check(base.store === null && base.vars.rowSpace === String(NOW.mult), "with no key stored the console draws the console's own 1.5", `store ${base.store}, var ${base.vars.rowSpace || "(unset)"}`);
      check(base.input && base.input.value === String(NOW.mult) && base.input.min === "1.2" && base.input.max === "2.4" && base.input.step === "0.05", "the row is a slider from 1.2 to 2.4, sitting on 1.5", JSON.stringify(base.input));
      check(base.input && base.input.readout === `${NOW.line.toFixed(1)}px`, "and it states that multiplier in the console's own pixels", base.input ? base.input.readout : "no readout");
      check(Boolean(base.preview) && Math.abs(base.preview.line - NOW.line) < 0.02, "the live preview beside it draws the same line box", JSON.stringify(base.preview));
      // Consecutive lines of console text are one line box apart, and every row kind inherits that number.
      const deltaAt = (s) => (s.pairs.length ? s.pairs[0].delta : null);
      check(base.pairs.length >= 2, "the transcript carries consecutive rows in one piece to measure the gap between", `${base.pairs.length} pairs`);
      check(Math.abs(deltaAt(base) - NOW.line) < 0.02, "two lines of console text sit exactly one line box apart", `${deltaAt(base)}px`);
      const rowKinds = new Set(base.rows.map((r) => r.cls.split(/\s+/).filter((c) => c === "jl" || c === "jl-tool" || c === "jl-tool-out").join(" ")));
      check(rowKinds.size >= 2, "the transcript carries more than one kind of console row", [...rowKinds].join(" / "));
      check(base.rows.every((r) => Math.abs(r.line - NOW.line) < 0.02), "every console row kind reads the same line box", base.rows.map((r) => `${r.cls.split(" ")[0]} ${r.line}`).join(", "));
      const preRect = { x: base.pre.left, y: base.pre.top, w: base.pre.width, h: base.pre.height };
      const baseStrip = await strip("space-default", preRect, { width: 640, height: 190 });
      out.spacing[0].b64 = baseStrip.b64;

      // ---- (4a) THE "BEFORE": the page with NO variable written at all ---------------------------------------
      // The claim is that an install that has never opened this row draws exactly what the panel drew before it
      // existed. So the variable is REMOVED - not set to 1.5 - and the stylesheet's own fallback has to draw today's
      // line box on its own.
      const removedVar = await page.evaluate(() => {
        document.documentElement.style.removeProperty("--con-row-space");
        return getComputedStyle(document.documentElement).getPropertyValue("--con-row-space").trim();
      });
      await page.waitForTimeout(120);
      const noVar = await readNow();
      const noVarStrip = await strip("space-before-no-variable", { x: noVar.pre.left, y: noVar.pre.top, w: noVar.pre.width, h: noVar.pre.height }, { width: 640, height: 190 });
      out.spacing.splice(1, 0, { name: "before-no-variable", ...noVar, b64: noVarStrip.b64 });
      check(!removedVar, "the variable is gone from the root, so nothing is carrying a number", removedVar || "(removed)");
      check(Math.abs(noVar.line - NOW.line) < 0.02 && Math.abs(deltaAt(noVar) - NOW.line) < 0.02, "the stylesheet's own 1.5 fallback draws today's line box and today's gap, with no setting written", `${noVar.line}px line, ${deltaAt(noVar)}px apart`);
      check(noVar.rows.every((r) => Math.abs(r.line - NOW.line) < 0.02), "and every console row kind falls back to it", noVar.rows.map((r) => `${r.cls.split(" ")[0]} ${r.line}`).join(", "));
      await page.evaluate(() => {
        if (typeof initConRowSpace === "function") initConRowSpace();
      });
      await page.waitForTimeout(100);
      const back = await readNow();
      check(Math.abs(back.line - NOW.line) < 0.02 && back.vars.rowSpace === String(NOW.mult), "and painting it again is the same picture", `${back.line}px`);
      const same = await diff(baseStrip.b64, noVarStrip.b64);
      // Two screenshots of a box cannot be compared with `===`: the clip origin rounds to whole pixels and the glyph
      // edges land a fraction differently, which shows up as a few hundred pixels a level or two apart. So the claim
      // is "the same picture to within antialiasing", stated with the number it was measured at.
      check(same.maxDelta <= 2 && same.differing < same.total * 0.01, "the before shot and the default shot are the same picture, differing only in sub-pixel antialiasing", `${same.differing} of ${same.total} px, max delta ${same.maxDelta}/255`);

      const readReply = () => page.evaluate((t) => {
        const el = document.querySelector(`#assistant .job[data-thread="${t}"] .reply-box`);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" "), height: Math.round(el.getBoundingClientRect().height * 100) / 100 };
      }, THREAD);
      const replyBefore = await readReply();
      check(Boolean(replyBefore), "the prompt box is on the page, so the setting can be proved not to touch it");

      for (const [name, value] of [["min", 1.2], ["max", 2.4]]) {
        check(await setRow(value), `${name}: the slider takes ${value}`, String(value));
        await page.waitForTimeout(140);
        const s = await readNow();
        const rec = { name, ...s };
        out.spacing.push(rec);
        const termPx = parseFloat(base.size) || TERM_PX;
        const want = termPx * value;
        check(Math.abs(s.line - want) < 0.02, `${name}: the console's line box is ${value} x ${termPx}px`, `${s.line}px, wanted ${want}px`);
        check(s.vars.rowSpace === String(value), `${name}: one variable carries it on :root`, `--con-row-space: ${s.vars.rowSpace || "(unset)"}`);
        check(Math.abs(deltaAt(s) - want) < 0.02, `${name}: two lines of console text are that far apart`, `${deltaAt(s)}px`);
        check(s.rows.every((r) => Math.abs(r.line - want) < 0.02), `${name}: every console row kind follows it`, s.rows.map((r) => `${r.cls.split(" ")[0]} ${r.line}`).join(", "));
        // A wrapped row moves by whole lines: the count of lines it holds does not change, its height does.
        if (base.wrapped && s.wrapped) {
          check(s.wrapped.rows === base.wrapped.rows, `${name}: the wrapped row still holds ${base.wrapped.rows} lines`, `${base.wrapped.rows} -> ${s.wrapped.rows}`);
          check(Math.abs(s.wrapped.height - base.wrapped.rows * want) < 0.6, `${name}: and its height is ${base.wrapped.rows} of those line boxes`, `${s.wrapped.height}px`);
        }
        check(Boolean(s.preview) && Math.abs(s.preview.line - want) < 0.02, `${name}: the live preview moves with it`, JSON.stringify(s.preview));
        check(s.store === String(value), `${name}: the choice is saved with the other wtgui.* settings`, `wtgui.conRowSpace = ${s.store}`);
        check(s.input && s.input.value === String(value), `${name}: the slider shows it`, s.input ? s.input.value : "no input");
        if (replyBefore) {
          const reply = await readReply();
          check(reply && reply.padding === replyBefore.padding, `${name}: the prompt box's own padding does not move`, `${replyBefore.padding} -> ${reply ? reply.padding : "gone"}`);
        }
        await strip(`space-${name}`, { x: s.pre.left, y: s.pre.top, w: s.pre.width, h: s.pre.height }, { width: 640, height: 190 }).then((shot) => {
          rec.b64 = shot.b64;
        });
      }

      // ---- (5) THE REASONING BLOCK FOLLOWS THE SAME VARIABLE ------------------------------------------------
      const cssText = readFileSync(path.join(TREE, "public", "style.css"), "utf8");
      check(/\.think-block \{[^}]*line-height: var\(--con-row-space, 1\.5\)/.test(cssText), "the reasoning block above a console reads the same variable, not a second number");
      // The console's own rule: the block that carries its font and size must also carry the row spacing, or one
      // setting could not move what the other two already move.
      const consoleBlock = (() => {
        let from = 0;
        for (;;) {
          const at = cssText.indexOf("font-family: var(--term)", from);
          if (at < 0) return null;
          const open = cssText.lastIndexOf("{", at);
          const close = cssText.indexOf("}", at);
          if (open < 0 || close < 0) return null;
          const body = cssText.slice(open, close);
          if (/font-size: var\(--term-size\)/.test(body)) return body;
          from = at + 1;
        }
      })();
      check(Boolean(consoleBlock) && /line-height: var\(--con-row-space, 1\.5\)/.test(consoleBlock), "the console's own line box is written from the one variable", consoleBlock ? "the rule that sets --term and --term-size also sets the line-height" : "no console rule found");
      check(/\.settings-preview\.sample-rows \{[^}]*var\(--con-row-space, 1\.5\)/.test(cssText), "and the preview the row draws beside itself is that same line box");

      // ---- (6) SAVED, AND RE-APPLIED ON THE NEXT LOAD -------------------------------------------------------
      await setRow(1.9);
      await page.waitForTimeout(120);
      const saved = await readNow();
      check(saved.store === "1.9" && saved.vars.rowSpace === "1.9", "a changed value is in the store before the reload", `store ${saved.store}, var ${saved.vars.rowSpace}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(`#assistant .job[data-thread="${THREAD}"] .turn pre.job-out .jl`, { timeout: 45_000 });
      await page.waitForTimeout(500);
      const reloaded = await readNow();
      out.spacing.push({ name: "reloaded-1.9", ...reloaded });
      check(reloaded && reloaded.vars.rowSpace === "1.9" && Math.abs(reloaded.line - TERM_PX * 1.9) < 0.02, "the next load draws it again, before anything is pressed", `${reloaded ? `${reloaded.line}px` : "no console"}`);

      // ---- (7) `use defaults` IS THE CONSOLE'S OWN 1.5 -----------------------------------------------------
      await openSettingsGroup(page, "display");
      await page.click("#con-row-reset");
      await page.waitForTimeout(140);
      const reset = await readNow();
      out.spacing.push({ name: "reset", ...reset });
      check(reset.vars.rowSpace === String(NOW.mult) && Math.abs(reset.line - NOW.line) < 0.02, "`use defaults` puts the console back to 1.5, the number it always had", `${reset.line}px`);
      check(reset.store === String(NOW.mult), "and the store agrees with it", reset.store);
      check(Math.abs(deltaAt(reset) - NOW.line) < 0.02, "the gap between two lines is the one the panel started with", `${deltaAt(reset)}px`);

      const errors = [...pageErrors];
      out.errors = errors.map((e) => String(e && e.message ? e.message : e));
      check(errors.length === 0, "no press raised a page error", `${errors.length}`);
      return true;
    },
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
} catch (err) {
  failures += 1;
  out.errors.push(String(err && err.stack ? err.stack : err));
  console.log(`FAIL  the run did not finish - ${err && err.message ? err.message : err}`);
} finally {
  await panel.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// Nothing this harness started may outlive it.
for (const pid of (out.browser && out.browser.pids) || []) if (pid && alivePid(pid)) alive.push(pid);
out.reaped = {
  browserPids: (out.browser && out.browser.pids) || [],
  browserPid: (out.browser && out.browser.browserPid) || null,
  processes: (out.browser && out.browser.processes) || 0,
  alive,
  sandbox: dir,
  sandboxRemoved: !existsSync(dir),
  profile: (out.browser && out.browser.profile) || null,
  profileRemoved: Boolean(out.browser && out.browser.profile && !existsSync(out.browser.profile)),
  shots: SHOTS,
};
console.log(`      browser pid ${out.reaped.browserPid || "(not reported)"} of ${out.reaped.processes} process(es) [${out.reaped.browserPids.join(", ") || "none"}]; still alive after close: ${alive.length ? alive.join(", ") : "none"}`);
console.log(`      reaped: ${dir} (panel sandbox${existsSync(dir) ? " STILL PRESENT" : ", removed"}); profile ${out.reaped.profile || "(not reported)"}${out.reaped.profileRemoved ? " (removed by the close)" : ""}`);
if (alive.length) {
  failures += 1;
  out.checks.push({ ok: false, label: "every browser this run started is gone", detail: alive.join(", ") });
}

// ---- the tables a reader reads first, in the console ------------------------------------------------------------
for (const kind of ["ui", "term"]) {
  console.log(`\n  ${kind === "ui" ? "UI_FONTS" : "TERM_FONTS"} - ${out.fonts[kind].length} entries, as the browser drew them`);
  for (const e of out.fonts[kind]) {
    console.log(`    ${e.id.padEnd(14)} ${e.painted.map((f) => f.family).join("+") || "(nothing drawn)"}${e.vsDefault == null ? "" : `  [${e.vsDefault} px vs default]`}`);
  }
}
console.log("");
for (const s of out.spacing) {
  const d = s.pairs && s.pairs.length ? s.pairs[0].delta : "n/a";
  console.log(`    ${String(s.name).padEnd(16)} --con-row-space ${String(s.vars ? s.vars.rowSpace : "").padEnd(5)} line ${String(s.line).padEnd(7)} gap ${d} store ${s.store}`);
}
console.log("");

out.verdict = { checks, failures, held: checks - failures, at: new Date().toISOString() };

// The ledger and the page are COMMITTED, so no line in them may name a folder on this machine: everything under the OS
// tree is written relatively and everything under the temp dir as `<tmp>/`.
function scrubString(v) {
  const tree = path.resolve(TREE);
  const tmp = path.resolve(tmpdir());
  return String(v)
    .split(tree + path.sep)
    .join("")
    .split(tmp + path.sep)
    .join("<tmp>/")
    .split(tree)
    .join(".")
    .split(tmp)
    .join("<tmp>")
    .split(path.sep)
    .join("/");
}
function scrubDeep(v) {
  if (typeof v === "string") return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]));
  return v;
}

// The images are inlined into the page and never named by path, so the page stands on its own.
if (JSON_OUT) {
  const ledger = scrubDeep({ ...out, suite: SUITE || null, version: VERSION || null });
  for (const kind of ["ui", "term"]) for (const e of ledger.fonts[kind]) delete e.b64;
  writeFileSync(JSON_OUT, JSON.stringify(ledger, null, 2));
  console.log(`      ledger ${JSON_OUT}`);
}
// The full ledger keeps the strips, so the page can be re-rendered later (--from) without measuring again.
if (LEDGER_OUT) {
  writeFileSync(LEDGER_OUT, JSON.stringify(scrubDeep({ ...out, suite: SUITE || null, version: VERSION || null })));
  console.log(`      full ledger ${LEDGER_OUT}`);
}
if (HTML_OUT) {
  writeFileSync(HTML_OUT, reportHtml({ ...out, suite: SUITE || null, version: VERSION || null }));
  console.log(`      report ${HTML_OUT}`);
}
console.log(`\n${checks - failures}/${checks} checks held${failures ? `, ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);

// ---- the page of what was measured ------------------------------------------------------------------------------
// One self-contained file: every strip is a data URL, so a reader who opens it sees the pictures and the numbers
// together without a folder of PNGs to keep beside it.
function reportHtml(ledger) {
  const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const faces = (e) => (e.painted.length ? e.painted.map((f) => `${f.family} (${f.glyphs})`).join(", ") : "nothing drawn");
  const section = (kind, title, lede) => {
    const entries = ledger.fonts[kind];
    const rows = entries
      .map((e) => {
        const vs = e.vsDefault == null ? "the default" : `${e.vsDefault} px`;
        return `<tr>
  <td class="id">${esc(e.id)}</td>
  <td>${esc(e.optionText || e.label)}</td>
  <td class="mono">${esc(faces(e))}</td>
  <td class="num">${esc(vs)}</td>
  <td><img alt="${esc(e.id)}" src="data:image/png;base64,${e.b64}"></td>
  <td class="stack mono">${esc(e.applied.family)}</td>
</tr>`;
      })
      .join("\n");
    return `<h2>${esc(title)}</h2>
<p class="lede">${lede}</p>
<table>
<thead><tr><th>entry</th><th>label says</th><th>the browser drew it in</th><th>px vs default</th><th>the same text, that entry</th><th>stack on the node</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
  };
  const spacingRows = ledger.spacing
    .map((s) => `<tr><td class="id">${esc(s.name)}</td><td class="num">${esc(s.vars.rowSpace || "(unset)")}</td><td class="num">${esc(s.line)}px</td><td class="num">${esc(s.pairs && s.pairs.length ? s.pairs[0].delta : "")}px</td><td class="num">${esc(s.wrapped ? `${s.wrapped.rows} lines / ${s.wrapped.height}px` : "")}</td><td class="num">${esc(s.preview ? `${s.preview.line}px` : "")}</td><td class="num">${esc(s.store || "(none)")}</td><td class="num">${esc(s.reply ? s.reply.padding : "")}</td></tr>`)
    .join("\n");
  const spacingFigs = ledger.spacing
    .filter((s) => s.b64)
    .map((s) => `<figure><img alt="${esc(s.name)}" src="data:image/png;base64,${s.b64}"><figcaption><b>${esc(s.name)}</b> - --con-row-space <span class="num">${esc(s.vars.rowSpace || "(unset)")}</span>, line box <span class="num">${esc(s.line)}px</span>, two rows <span class="num">${esc(s.pairs && s.pairs.length ? s.pairs[0].delta : "")}px</span> apart, prompt box padding <span class="num">${esc(s.reply ? s.reply.padding : "n/a")}</span></figcaption></figure>`)
    .join("\n");
  const failed = ledger.checks.filter((c) => !c.ok);
  const verdict = ledger.verdict || { held: 0, checks: ledger.checks.length, failures: failed.length };
  const reaped = ledger.reaped || {};
  // The entries the audit removed, re-drawn from the base commit's own stack: the "before" of the two tables above.
  const removed = (kind) => {
    const list = (ledger.retired && ledger.retired[kind]) || [];
    if (!list.length) return "";
    const rows = list
      .map((r) => `<tr><td class="id">${esc(r.id)}</td><td class="mono stk">${esc(r.stack)}</td><td class="mono">${esc(faces(r))}</td><td class="id">${esc(r.owner)}</td><td class="num">${esc(r.differing)} px</td><td><img alt="${esc(r.id)}" src="data:image/png;base64,${r.b64}"></td></tr>`)
      .join("\n");
    return `<h3>Removed from ${kind === "term" ? "TERM_FONTS" : "UI_FONTS"} - ${list.length} entries, re-drawn from the base commit</h3>
<p class="lede">Each of these was drawn again from the stack it shipped in <code>${esc((ledger.retired && ledger.retired.base) || "the base commit")}</code>, in this same browser, on the same line. Every one of them came out as the same picture as the entry named under "now drawn by" - that is why it left the list. A reader whose stored choice was one of these keeps the picture they had: <code>FONT_RETIRED</code> maps the retired id to the entry that draws it.</p>
<table><thead><tr><th>entry</th><th>the stack it shipped</th><th>the browser drew it in</th><th>now drawn by</th><th>pixels apart</th><th>the same text, that entry</th></tr></thead><tbody>
${rows}
</tbody></table>`;
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The console's fonts, and the console's row spacing</title>
<style>
  body { margin: 0; padding: 28px 32px 60px; background: #0d1117; color: #cfd8e3; font: 14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 21px; margin: 0 0 6px; color: #e6edf6; }
  h2 { font-size: 16px; margin: 34px 0 4px; color: #e6edf6; border-bottom: 1px solid #222a36; padding-bottom: 5px; }
  h3 { font-size: 13.5px; margin: 26px 0 2px; color: #cbd6e3; }
  .stk { color: #8b9bb0; max-width: 300px; word-break: break-all; }
  p.lede { max-width: 1120px; color: #9fb0c3; margin: 4px 0 16px; }
  .num { color: #7ee787; }
  .id { color: #ffd479; font: 12px/1.4 ui-monospace, Consolas, monospace; }
  .mono { font: 11.5px/1.45 ui-monospace, Consolas, monospace; color: #b8c6d8; }
  .stack { color: #8b9bb0; max-width: 320px; }
  table { border-collapse: collapse; margin: 10px 0 26px; width: 100%; }
  th, td { border-bottom: 1px solid #222a36; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { color: #8b9bb0; font-weight: 600; font-size: 12px; }
  td img { display: block; border: 1px solid #222a36; border-radius: 4px; }
  figure { margin: 0 0 30px; }
  figure img { display: block; border: 1px solid #222a36; border-radius: 6px; }
  figcaption { margin-top: 6px; color: #9fb0c3; font-size: 12.5px; }
  .ok { color: #7ee787; } .bad { color: #ff9c94; }
  code { color: #ffd479; }
</style>
</head>
<body>
<h1>The console's fonts, and the console's row spacing</h1>
<p class="lede"><b class="${failed.length ? "bad" : "ok"}">${verdict.held} of ${verdict.checks} checks held${failed.length ? `, ${failed.length} FAILED` : ""}</b>.
Measured in headless Chromium at 1440x900 on a throwaway panel: one open turn whose console carries three physical
lines, a tool call, its output and one long wrapping row. Each entry below was applied through the page's own
<code>applyFont</code>, then the browser was asked which face actually drew the glyphs
(<code>CSS.getPlatformFontsForNode</code>), and the SAME rect of text was captured and diffed pixel by pixel against
every other entry. A row in <b>both</b> tables that drew the same faces <i>and</i> the same pixels is the duplicate this
audit exists to remove: there are ${ledger.duplicated.length}.</p>

${section("ui", `UI_FONTS - the page's own labels (${ledger.fonts.ui.length} entries)`, "Measured on the Display tab's panel-font preview, which is a UI label drawn in <code>--ui</code>. Every entry here changes how the label is drawn, and no two of them draw it the same.")}
${removed("ui")}
${section("term", `TERM_FONTS - the console (${ledger.fonts.term.length} entries)`, "Measured on a line of console text drawn in <code>--term</code>, carrying the sequences a coding font ligates. Every entry here changes the console's own pixels.")}
${removed("term")}

<h2>Console row spacing</h2>
<p class="lede">One variable, <code>--con-row-space</code>, a multiplier on the console's line-height. 1.5 is the number
the console has always used, so an unset key draws exactly the panel's old look: <span class="num">17.25px</span> of
line box at the default 11.5px text. The gap between two lines of console text is that line box, every row kind
inherits it, and the prompt box's padding never moves.</p>
<table>
<thead><tr><th>state</th><th>--con-row-space</th><th>line box</th><th>two rows apart</th><th>wrapped row</th><th>preview</th><th>store</th><th>prompt box padding</th></tr></thead>
<tbody>
${spacingRows}
</tbody>
</table>
${spacingFigs}

<h2>The gate</h2>
<table>
<thead><tr><th>what</th><th>answer</th></tr></thead>
<tbody>
<tr><td>this harness</td><td class="mono">node tools/verify-console-fonts.mjs - ${esc(verdict.held)}/${esc(verdict.checks)} checks held${failed.length ? `, ${failed.length} FAILED` : ""}</td></tr>
<tr><td>the repo's suite</td><td class="mono">${esc(ledger.suite || SUITE || "(run npm test and pass --suite to record it here)")}</td></tr>
<tr><td>the version</td><td class="mono">${esc(ledger.version || VERSION || "(pass --version)")}</td></tr>
<tr><td>browser pid / profile</td><td class="mono">${esc(reaped.browserPid || "(not reported)")} of ${esc(reaped.processes || 0)} processes [${esc((reaped.browserPids || []).join(", ") || "none")}] / ${esc(reaped.profile || "(none reported)")}${reaped.profileRemoved ? " - removed on close" : ""}</td></tr>
<tr><td>still alive after the close</td><td class="mono">${esc((reaped.alive || []).length ? `STILL RUNNING: ${reaped.alive.join(", ")}` : "none")}</td></tr>
<tr><td>panel sandbox</td><td class="mono">${esc(reaped.sandbox || "")} - ${reaped.sandboxRemoved ? "removed" : "STILL PRESENT"}</td></tr>
</tbody>
</table>
${failed.length ? `<h2>What failed</h2>\n<ul>\n${failed.map((c) => `<li><b>${esc(c.label)}</b> - ${esc(c.detail)}</li>`).join("\n")}\n</ul>` : ""}
</body>
</html>
`;
}
