// The stuck-turn chip: a quiet or reaped worker run, visible on its row without opening the job store.
//
// The reaper (lib/jobs.js sweepStalledRuns) and the compaction trigger both write what they did onto the job:
// `stuck` (the card's readout), `reaped` (the reaper's reason) and `compaction` (what the gateway answered). The
// chip is drawn from THOSE fields only - public/render-jobs.js `stuckChipHtml`, beside the live pulse - so a person
// sees a quiet or reaped run at a glance. These cases drive the shipped function over the same objects /api/jobs
// carries, and pin that the card head draws it and the sheet styles it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../public/render-jobs.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The function, cut from the shipped file by its own region markers and driven with the page's escaper.
function chip() {
  const start = src.indexOf("// ---- the stuck-turn chip");
  const end = src.indexOf("// ---- end the stuck-turn chip");
  assert.ok(start >= 0 && end > start, "public/render-jobs.js carries the stuck-turn chip region");
  const body = src.slice(start, end);
  return new Function("esc", `${body}; return stuckChipHtml;`)(esc);
}

const stuckChipHtml = chip();

test("a reaped run draws a reaped chip carrying the reaper's own reason", () => {
  const reason =
    "reaped: nothing on the run's stream for 45m 00s (the 10m 00s quiet window) and the run is 72m 00s old, past its 1800s budget";
  const html = stuckChipHtml({
    id: "job-1",
    status: "interrupted",
    stuck: { state: "reaped", quietSeconds: 2700, budgetSeconds: 1800, windowSeconds: 600, reason },
    reaped: { reason },
  });
  assert.match(html, /data-stuck="reaped"/, "the state is a field, not a colour");
  assert.match(html, /class="stuck-chip is-reaped"/);
  assert.match(html, />reaped · 45m quiet</, "the chip says reaped and how long it was quiet");
  assert.ok(html.includes(esc(reason)), "the reason is in the tooltip, escaped");
  assert.match(html, /wall-clock cap/, "and says why this row is not waiting for the cap");
});

test("a quiet run draws an amber chip that says whether it is watched or about to be stopped", () => {
  const over = stuckChipHtml({
    status: "running",
    stuck: { state: "quiet", quietSeconds: 1800, windowSeconds: 600, budgetSeconds: 1800, overBudget: true },
  });
  assert.match(over, /class="stuck-chip is-quiet"/);
  assert.match(over, />quiet 30m</);
  assert.match(over, /past its 1800s budget, so the reaper stops it/);

  const inside = stuckChipHtml({
    status: "running",
    stuck: { state: "quiet", quietSeconds: 700, windowSeconds: 600, budgetSeconds: 1800, overBudget: false },
  });
  assert.match(inside, />quiet 12m</);
  assert.match(inside, /watched, not stopped/);
});

test("a compacting run says so, in the gateway's own words, instead of being accused of a stall", () => {
  const html = stuckChipHtml({
    status: "running",
    stuck: { state: "compacting", quietSeconds: 120, reason: "📦 Preflight compression: ~339,000 tokens >= 200,000 threshold." },
  });
  assert.match(html, /data-stuck="compacting"/);
  assert.match(html, /class="stuck-chip is-compacting"/);
  assert.match(html, />compacting · 2m</);
  assert.ok(html.includes("Preflight compression"), "the gateway's sentence is the tooltip");
  assert.match(html, /not a stall/);
});

test("a moving run draws nothing at all", () => {
  assert.equal(stuckChipHtml({ status: "running", stuck: null }), "", "no stuck field, no chip");
  assert.equal(stuckChipHtml({ status: "running" }), "");
  assert.equal(stuckChipHtml({ status: "running", stuck: { state: "unknown" } }), "", "an unknown state draws nothing");
  assert.equal(stuckChipHtml(null), "");
});

test("the card head draws the chip from the job's own field, and the sheet styles every state", () => {
  assert.match(src, /\$\{stuckChipHtml\(latest\)\}/, "conversationHtml's head draws it beside the pulse");
  assert.match(src, /:\$\{t\.stuck\?\.state \|\| ""\}/, "the repaint signature moves when the state does");
  for (const state of ["is-quiet", "is-reaped", "is-compacting"]) {
    assert.ok(css.includes(`.stuck-chip.${state}`), `public/style.css styles .stuck-chip.${state}`);
  }
});
