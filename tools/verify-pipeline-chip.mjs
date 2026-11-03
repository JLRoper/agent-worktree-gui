// The agent card's head draws a `pipeline: <id>` chip — the id and its stage — and draws NOTHING when the tree has
// no pipeline record.
//
//   node tools/verify-pipeline-chip.mjs                       # this checkout
//   node tools/verify-pipeline-chip.mjs --root <export dir>    # serve a `git archive` of another build
//   node tools/verify-pipeline-chip.mjs --shots <dir>          # where the screenshots go (default: a temp dir)
//   node tools/verify-pipeline-chip.mjs --json <file>          # keep the raw ledger
//
// THE RECORD. `lib/jobs.js` writes `pipeline` on every job row (`summary()`, via `pipelineForJob`) and a cut writes
// `{id: "local", stage: "work", since, history[]}` into the tree's durable book (`lib/pipelines.js`, docs/pipelines.md
// §3). The page drew none of it: before this change "pipeline" appeared zero times in public/app.js, public/style.css
// and public/index.html.
//
// THE THREE STATES, which is all this gate knows how to accept:
//   1. a record WITH a stage  -> `pipeline: <id> · <stage>`  (data-pipeline, data-pipeline-stage)
//   2. a record with NO stage -> `pipeline: <id>` alone, and no separator
//   3. no record              -> NOTHING: no chip, no "local" stand-in, no empty pill
//
// WHAT IT ALSO PINS. The chip is a span, not a control (the switch route is a 501 until it starts a turn, so a press
// would promise work that cannot happen); it sits in `.job-head` beside the state pill, one gap from it; and it takes
// the host chip's pill metrics — `button.btn-host` is the shipped chip of that shape, so this measures a real one
// beside the card and compares height, font size and line height rather than trusting a copy of the numbers.
//
// THE HEAD IS ONE ROW. `.job-head` is `flex-wrap: nowrap`; the head's height, the chip's one line, the controls'
// cluster still flush at the head's right edge, and no horizontal overrun are measured at a 1600 and a 1280 window and
// in the 480px docked rail — the rail is 480px whatever the window is, which is the width that has broken a head item
// before (the turn pager's count, 0.73.3).
//
// WHAT IS DRIVEN (nothing synthetic reaches the page): a throwaway panel of its own (tools/panel-testkit.mjs — spare
// port, own PANEL_CONFIG / HERMES_HOME / jobs.json), a dead apiServer and the board assistant OFF so no gateway is
// called at all, and a job store seeded with four settled turns: three cards in `#jobs` (one per state) and the
// assistant's own card, which is what the docked rail paints through the same `conversationHtml`.
//
// THE FAILING-FIRST PROOF is the `--root` flag, on the rule the other gates use — the same harness, the base's own
// server.js, lib/ and public/:
//   mkdir -p "$SCRATCH/main" && git archive origin/main | tar -x -C "$SCRATCH/main"
//   git -C "$SCRATCH/main" init -q -b main && git -C "$SCRATCH/main" add -A && git -C "$SCRATCH/main" commit -qm export
//   node tools/verify-pipeline-chip.mjs --root "$SCRATCH/main"
// 0.73.3's public/ has no chip at all, so every chip check fails there and this checkout passes. The export needs its
// own one-commit repository because server.js reads `git rev-parse` at boot and dies on a bare export.
//
// Exit codes: 0 held; 1 a check failed; 2 the run did not measure what it claims (no Playwright, no card, no rail).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-pipeline-chip-shots")));
const JSON_OUT = opt("--json");
const WIDTHS = [1600, 1280];
const RAIL_PX = 480;

// One card per state, each in its own tree: `pipelineForJob` reads the TREE's book first, and the sandbox's book is
// empty, so each card's own copy on the job is what the page receives — exactly the field the brief names.
const WITH_STAGE = "fixture-pipeline-with-stage";
const ID_ONLY = "fixture-pipeline-id-only";
const NO_RECORD = "fixture-pipeline-no-record";
const RAIL_THREAD = "panel-assistant";
const TREE_OF = (slug) => `C:/ProjectDevelopment/agent-worktree-gui/.worktrees/${slug}`;
const RECORD_STAGE = { id: "turnover", stage: "push", since: new Date(Date.now() - 3_600_000).toISOString(), history: [] };
const RECORD_ID_ONLY = { id: "investigation", stage: null, since: new Date(Date.now() - 7_200_000).toISOString(), history: [] };

let checks = 0;
let failures = 0;
const out = { tree: TREE, widths: {}, states: {}, notMeasured: [], errors: [] };
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);

// ---- the fixture ------------------------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-pipeline-chip-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
const now = Date.now();
const settled = (id, thread, extra) => ({
  id,
  thread,
  turn: 0,
  prompt: `fixture: ${thread}`,
  status: "done",
  exitCode: 0,
  startedAt: new Date(now - 600_000).toISOString(),
  endedAt: new Date(now - 540_000).toISOString(),
  durationMs: 60_000,
  finalMessage: "done",
  lines: [{ kind: "out", text: `fixture: ${thread}`, lid: 1, at: now - 540_000 }],
  ...extra,
});
const treeOf = (slug) => TREE_OF(slug);
const jobs = [
  settled("tkpipe01", WITH_STAGE, { cwd: treeOf(WITH_STAGE), ownerPath: treeOf(WITH_STAGE), worktreePath: treeOf(WITH_STAGE), pipeline: RECORD_STAGE }),
  settled("tkpipe02", ID_ONLY, { cwd: treeOf(ID_ONLY), ownerPath: treeOf(ID_ONLY), worktreePath: treeOf(ID_ONLY), pipeline: RECORD_ID_ONLY }),
  // No `pipeline` key at all: the shape a job whose tree has no record is persisted as (`pipeline: j.pipeline || null`).
  settled("tkpipe03", NO_RECORD, { cwd: treeOf(NO_RECORD), ownerPath: treeOf(NO_RECORD), worktreePath: treeOf(NO_RECORD) }),
  // The card the docked rail paints: the assistant's own thread, with a record that HAS a stage so the rail measures
  // the chip at 480px rather than an empty head.
  settled("tkpipe04", RAIL_THREAD, { cwd: treeOf(RAIL_THREAD), ownerPath: treeOf(RAIL_THREAD), worktreePath: treeOf(RAIL_THREAD), pipeline: RECORD_STAGE }),
];
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));

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

// ---- the measurement --------------------------------------------------------------------------------------------
// Everything this gate reads comes off the painted DOM. A host chip is built beside the card from the shipped class, so
// "same pill height, type scale and gap" is compared with the real thing rather than with a copy of its numbers.
function measure(args) {
  const [threads, railThread] = args;
  const R = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const round = (n) => Math.round(n * 100) / 100;
    return { l: round(r.left), t: round(r.top), r: round(r.right), b: round(r.bottom), w: round(r.width), h: round(r.height) };
  };
  // The board and the docked rail paint the SAME thread twice (the rail's card is not a board card), so every read
  // names the container it means: `#jobs` for the three board cards, `#assistant` for the rail's.
  const cardOf = (thread, scope) => document.querySelector(`${scope} .job[data-thread="${CSS.escape(thread)}"]`);
  const cardFacts = (thread, scope = "#jobs") => {
    const j = cardOf(thread, scope);
    if (!j) return { error: `no card for ${thread} in ${scope}` };
    const head = j.querySelector(".job-head");
    const chip = head ? head.querySelector(".pipeline-chip") : null;
    const pill = [...head.querySelectorAll(":scope > .pill")][0] || null;
    const cluster = j.querySelector(".job-actions");
    const cs = chip ? getComputedStyle(chip) : null;
    const headCs = head ? getComputedStyle(head) : null;
    // Any text in the card reading `pipeline:` without a chip: that is the "local stand-in" / hand-typed pill the
    // brief forbids, and it would pass a chip-only assertion.
    const text = (j.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    return {
      head: R(head),
      headWrap: headCs ? headCs.flexWrap : null,
      headGap: headCs ? headCs.columnGap : null,
      headOverflow: head ? Math.round((head.scrollWidth - head.clientWidth) * 100) / 100 : null,
      chip: R(chip),
      chipExists: Boolean(chip),
      chipTag: chip ? chip.tagName : null,
      chipText: chip ? chip.textContent.replace(/\s+/g, " ").trim() : null,
      chipData: chip ? { id: chip.dataset.pipeline ?? null, stage: chip.dataset.pipelineStage ?? null } : null,
      chipOneLine: chip ? chip.scrollHeight <= chip.clientHeight + 1 : null,
      chipScroll: chip ? { sw: chip.scrollWidth, cw: chip.clientWidth } : null,
      chipWhiteSpace: cs ? cs.whiteSpace : null,
      chipFont: cs ? { size: cs.fontSize, line: cs.lineHeight } : null,
      chipGapFromPill: chip && pill ? Math.round((chip.getBoundingClientRect().left - pill.getBoundingClientRect().right) * 100) / 100 : null,
      chipInsideHead: Boolean(chip && head && head.contains(chip)),
      pill: R(pill),
      pillText: pill ? pill.textContent.replace(/[\u21bb]/g, "").trim() : null,
      cluster: R(cluster),
      pipelineLines: text.filter((s) => /pipeline:/i.test(s)),
      card: R(j),
      collapsed: j.classList.contains("collapsed"),
    };
  };
  // The shipped host chip, built once and measured off-screen: `.btn-host` is the pill this chip has to match.
  let host = null;
  if (!document.querySelector("[data-gate-host-probe]")) {
    const probe = document.createElement("button");
    probe.className = "btn-host is-mapped";
    probe.setAttribute("data-gate-host-probe", "1");
    probe.textContent = "host: github";
    probe.style.position = "absolute";
    probe.style.left = "-9999px";
    probe.style.top = "0";
    document.body.appendChild(probe);
  }
  const hp = document.querySelector("[data-gate-host-probe]");
  if (hp) {
    const cs = getComputedStyle(hp);
    host = { box: R(hp), font: { size: cs.fontSize, line: cs.lineHeight }, padding: `${cs.paddingTop} ${cs.paddingRight}`, border: cs.borderTopWidth, radius: cs.borderTopLeftRadius };
  }
  const rail = document.getElementById("assistant");
  return {
    host,
    rail: rail ? { hidden: rail.hidden, w: Math.round(rail.getBoundingClientRect().width), card: cardFacts(railThread, "#assistant") } : null,
    cards: Object.fromEntries(threads.map((t) => [t, cardFacts(t)])),
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}

const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log(notRun("the pipeline chip on the agent card", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)"));
  process.exit(2);
}

const near = (a, b, eps = 1) => a !== null && b !== null && Math.abs(a - b) <= eps;

try {
  console.log(`pipeline chip gate on ${TREE}`);
  console.log(`  sandbox: ${panel.base} · 3 board cards + the rail card · no gateway · shots ${SHOTS}`);
  mkdirSync(SHOTS, { recursive: true });
  await withBrowser(
    async ({ page, pageErrors }) => {
      await page.addInitScript(() => {
        try {
          localStorage.setItem("wm.assistantOpen", "1");
          localStorage.setItem("wtgui.autoCollect", "0");
        } catch {
          /* a browser with storage off still draws the board */
        }
      });
      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`#jobs .job[data-thread="${WITH_STAGE}"]`, { timeout: 45_000 });
      await page.waitForSelector(`#assistant .job[data-thread="${RAIL_THREAD}"]`, { timeout: 45_000 });
      await page.waitForTimeout(900);

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForTimeout(600);
        const m = await page.evaluate(measure, [[WITH_STAGE, ID_ONLY, NO_RECORD], RAIL_THREAD]);
        out.widths[width] = m;
        const tag = `${width}px`;
        if (m.rail && m.rail.hidden === false && Math.abs(m.rail.w - RAIL_PX) > 1) out.notMeasured.push(`${tag}: the rail is ${m.rail.w}px, not ${RAIL_PX}`);

        // ---- state 1: a record with a stage draws the id AND the stage ----
        const a = m.cards[WITH_STAGE];
        out.states[width] = { withStage: a, idOnly: m.cards[ID_ONLY], none: m.cards[NO_RECORD], rail: m.rail?.card };
        if (a.error) {
          check(false, `${tag}: the card with a staged record is on the page`, a.error);
        } else {
          check(a.chipExists, `${tag}: a staged record draws a chip`, a.chipExists ? a.chipText : "no .pipeline-chip in the head");
          check(a.chipText === "pipeline: turnover · push", `${tag}: the chip reads the id and the stage`, JSON.stringify(a.chipText));
          check(
            a.chipData?.id === "turnover" && a.chipData?.stage === "push",
            `${tag}: the chip carries the record's id and stage as data`,
            JSON.stringify(a.chipData),
          );
          // A red run (0.73.3 has no chip) has to report every check rather than dying on the first missing node.
          const shape = a.chip && m.host ? true : null;
          check(shape !== null, `${tag}: the chip has a box to measure beside the host chip`, shape === null ? `chip ${Boolean(a.chip)} · host ${Boolean(m.host)}` : "both present");
          if (shape !== null) {
            check(a.chipTag === "SPAN", `${tag}: the chip is a span, not a control that promises a switch`, String(a.chipTag));
            check(a.chipInsideHead, `${tag}: the chip lives in the card's head`, `head ${Boolean(a.head)} · chip ${Boolean(a.chip)}`);
            check(
              near(a.chip.h, m.host.box.h) && near(parseFloat(a.chipFont.size), parseFloat(m.host.font.size), 0.01) && near(parseFloat(a.chipFont.line), parseFloat(m.host.font.line), 0.01),
              `${tag}: the chip has the host chip's pill height and type scale`,
              `chip ${a.chip.h}px / ${a.chipFont.size} on ${a.chipFont.line} · host ${m.host.box.h}px / ${m.host.font.size} on ${m.host.font.line}`,
            );
            check(
              a.chipGapFromPill !== null && near(a.chipGapFromPill, parseFloat(a.headGap), 1),
              `${tag}: the chip sits one head gap beside the state pill`,
              `chip ${a.chipGapFromPill}px from the pill · head gap ${a.headGap}`,
            );
            // ---- the head is still one row ----
            check(a.head.h <= 34, `${tag}: the head is one row high`, `${a.head.h}px tall (head ${a.head.t}-${a.head.b})`);
            check(a.chipOneLine === true, `${tag}: the chip is on one line`, `${a.chip.h}px tall, white-space ${a.chipWhiteSpace}`);
            check(
              Boolean(a.chipScroll) && a.chipScroll.sw <= a.chipScroll.cw + 1,
              `${tag}: the chip is drawn in full, not ellipsized`,
              a.chipScroll ? `${a.chipScroll.cw}px of ${a.chipScroll.sw}px of text` : "no chip",
            );
            check(
              Boolean(a.cluster) && a.head.r - a.cluster.r <= 4,
              `${tag}: the controls still end at the head's right edge`,
              a.cluster ? `head right ${a.head.r} · cluster right ${a.cluster.r}` : "no .job-actions cluster",
            );
            check(a.headOverflow !== null && a.headOverflow <= 1, `${tag}: the head does not overrun its card`, `${a.headOverflow}px of overflow`);
          }
        }

        // ---- state 2: a record with no stage draws the id alone ----
        const b = m.cards[ID_ONLY];
        if (b.error) {
          check(false, `${tag}: the card with an id-only record is on the page`, b.error);
        } else {
          check(b.chipExists && b.chipText === "pipeline: investigation", `${tag}: a record with no stage draws the id alone`, JSON.stringify(b.chipText));
          check(b.chipExists && b.chipData?.id === "investigation" && b.chipData?.stage === null, `${tag}: the id-only chip carries no stage`, JSON.stringify(b.chipData));
          check(b.chipExists && !/·/.test(String(b.chipText)), `${tag}: the id-only chip has no separator and no trailing stage`, JSON.stringify(b.chipText));
          check(b.head.h <= 34, `${tag}: the id-only card's head is one row high`, `${b.head.h}px tall`);
        }

        // ---- state 3: no record draws NOTHING ----
        const c = m.cards[NO_RECORD];
        if (c.error) {
          check(false, `${tag}: the card with no record is on the page`, c.error);
        } else {
          check(!c.chipExists, `${tag}: a card with no record draws no chip`, c.chipExists ? `drew ${JSON.stringify(c.chipText)}` : "no .pipeline-chip");
          check(c.pipelineLines.length === 0, `${tag}: a card with no record draws no "pipeline:" text at all — never "local", never an empty pill`, JSON.stringify(c.pipelineLines));
          check(c.head.h <= 34, `${tag}: the no-record card's head is one row high`, `${c.head.h}px tall`);
        }

        // ---- the docked rail: the same chip at 480px ----
        const r = m.rail?.card;
        if (!r || r.error) {
          out.notMeasured.push(`${tag}: the rail card was not on the page`);
        } else {
          check(m.rail.hidden === false && Math.abs(m.rail.w - RAIL_PX) <= 1, `${tag}: the card is measured in the docked rail`, `#assistant ${m.rail.hidden ? "hidden" : "visible"}, ${m.rail.w}px wide (want ${RAIL_PX})`);
          check(r.chipExists, `${tag} rail: the chip is drawn in the rail`, r.chipExists ? r.chipText : "no .pipeline-chip");
          check(r.head.h <= 34, `${tag} rail: the head stays one row high with the chip present`, `${r.head.h}px tall (head ${r.head.t}-${r.head.b})`);
          check(Boolean(r.chip) && r.chipOneLine === true, `${tag} rail: the chip stays one line`, r.chip ? `${r.chip.h}px tall, white-space ${r.chipWhiteSpace}` : "no chip");
          check(Boolean(r.chip) && r.chip.w >= 88, `${tag} rail: the chip keeps a readable width instead of collapsing to "pipelin…"`, r.chip ? `${r.chip.w}px wide` : "no chip");
          // The rail is the one width with no room for the whole record: the chip trims its tail there and the full
          // record stays in its title. Pinned, so a later stylesheet cannot silently make it "pipelin…" again.
          check(Boolean(r.chipScroll) && r.chipScroll.sw > r.chipScroll.cw, `${tag} rail: the chip trims its tail rather than wrapping or overflowing`, r.chipScroll ? `${r.chipScroll.cw}px of ${r.chipScroll.sw}px shown` : "no chip");
          check(Boolean(r.cluster) && r.head.r - r.cluster.r <= 4, `${tag} rail: the controls still end at the head's right edge`, r.cluster ? `head right ${r.head.r} · cluster right ${r.cluster.r}` : "no cluster");
          check(r.headOverflow !== null && r.headOverflow <= 1, `${tag} rail: the head does not overrun the card`, `${r.headOverflow}px of overflow`);
        }

        // ---- the picture the report is about: the HEAD of each card, which is the thing that changed ----
        for (const [name, thread] of [["with-stage", WITH_STAGE], ["id-only", ID_ONLY], ["no-record", NO_RECORD]]) {
          const head = page.locator(`#jobs .job[data-thread="${thread}"] .job-head`);
          const shot = path.join(SHOTS, `pipeline-chip-${width}-${name}.png`);
          try {
            await head.scrollIntoViewIfNeeded({ timeout: 5000 });
            await page.waitForTimeout(120);
            await head.screenshot({ path: shot });
          } catch {
            // A card that scrolled out of reach is not a failed check: the picture is evidence, not a measurement.
            await page.screenshot({ path: shot }).catch(() => {});
          }
          note(`screenshot ${shot}`);
        }
        // …and the rail's own card, which is the one width where the chip has to give something up.
        {
          const shot = path.join(SHOTS, `pipeline-chip-${width}-rail.png`);
          try {
            const box = await page.locator("#assistant").boundingBox();
            await page.screenshot(box ? { path: shot, clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.max(1, box.width), height: Math.min(box.height, 420) } } : { path: shot });
          } catch {
            await page.screenshot({ path: shot }).catch(() => {});
          }
          note(`screenshot ${shot}`);
        }
      }
      out.errors = (pageErrors || []).slice(0, 3);
      check(out.errors.length === 0, "no page error along the way", out.errors[0] || "clean");
    },
    { viewport: { width: WIDTHS[0], height: 1000 } },
  );
} finally {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1), "utf8");
for (const f of out.notMeasured) console.log(`  ? ${f}`);
if (out.notMeasured.length) {
  console.log(`RESULT: NOT MEASURED (${out.notMeasured.length} reason(s))`);
  process.exit(2);
}
console.log(failures ? `RESULT: ${failures}/${checks} FAILED` : `RESULT: ALL PASS (${checks} checks)`);
process.exit(failures ? 1 : 0);
