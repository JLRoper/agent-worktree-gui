#!/usr/bin/env node
// THE WAVE STATION'S DISC, MEASURED IN RENDERED PIXELS, IN EVERY STATE, AT TWO PANE WIDTHS.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-wave-dot-opacity.mjs [--shots <dir>] [--json <file>] [--baseline <file>]
//
// WHAT THIS GATE PROVES, and why each half is a measurement rather than a look:
//
//   1. THE CONNECTOR DOES NOT SHOW THROUGH THE DISC. The lane draws one vertical connector down an initiative card and
//      puts a station (`.wave-pos`) on it. For every wave state the panel can derive, the disc's inner area is sampled
//      from a real screenshot: on the rows clear of the label, the run of pixels across the disc is ONE colour, so no
//      stripe of the connector runs through it. The count of stray pixels in the connector's own two columns is the
//      number the report quotes, and it must be 0. Before this change it was not 0 on the wave the card marks current:
//      that disc painted the running tint `--tab-run-bg` (rgba, alpha 0.14) and the connector showed through it.
//   2. THE RING IS STILL LEGIBLE, AND THE LINE STILL MEETS IT. The ring's own stroke is sampled at four cardinal points
//      and its colour is compared with the disc's interior as a WCAG contrast ratio; the connector is sampled just
//      above and just below the ring in the SAME colour it has further up the lane, so hiding it inside the disc did
//      not clip it at the edge and the lane still reads as a route rather than a broken line.
//   3. THE DOT KEEPS ITS OWN COLOURS. Every dot's interior, ring colour and ring contrast is written to the run's JSON.
//      With `--baseline <json>` from a run on the base tree, the gate also asserts the interior moved by at most 2 per
//      channel and the ring contrast did not fall - this is an opacity and stacking fix, not a restyle.
//   4. BOTH DRAWINGS. Every dot is measured at two pane widths: the default dock (a ~480px pane) and a wide dock (a
//      ~1100px pane, where the Initiatives container query takes over), because the states are painted by rules that
//      differ between them.
//   5. HEALTH: zero page errors and zero console errors.
//
// The states are seeded, not waited for: three initiatives hold a wave in every state lib/waves.js can derive (empty,
// unentered, unknown, ready, running, blocked, done, abandoned), plus the wave a card surfaces as the next one to
// open (`autoOpen.surface`), which is the wave the reader's screenshot showed the line through.
//
// Sandbox only: its own config, port and state directory, two throwaway git trees, and an apiServer pointed at a dead
// port. The live panel on 7331 and ~/.wag are never touched. Without Playwright the script says BROWSER-NOT-RUN and
// exits 2 rather than passing on a half that never ran.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { git, post, startPanel, waitForState } from "./panel-testkit.mjs";
import { readQueueFile, writeQueueFile } from "../lib/assistant/queue.js";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pixels, with no dependency -------------------------------------------------------------------------------------
// A PNG decoder for the one shape Chromium's `page.screenshot` writes (8-bit, non-interlaced, RGB or RGBA). It is here
// rather than in the browser so the same function can read a shot saved on disk: the report's numbers can be derived
// again from the files it ships, months later, by anyone.
export function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString("latin1", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG: unsupported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height) throw new Error("PNG has no IHDR");
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth}: unsupported`);
  // 2 = truecolour, 6 = truecolour with alpha. The screenshot is one of those two.
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`PNG colour type ${colorType}: unsupported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let off = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[off];
    off += 1;
    const line = Buffer.from(raw.subarray(off, off + stride));
    off += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const v = line[i];
      if (filter === 1) line[i] = (v + a) & 255;
      else if (filter === 2) line[i] = (v + b) & 255;
      else if (filter === 3) line[i] = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (filter !== 0) {
        throw new Error(`PNG filter ${filter}: unsupported`);
      }
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      data[d] = line[s];
      data[d + 1] = line[s + 1];
      data[d + 2] = line[s + 2];
      data[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data };
}

/** One pixel, as [r, g, b, a]. */
export function pixelAt(raster, x, y) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= raster.width || yi >= raster.height) return null;
  const i = (yi * raster.width + xi) * 4;
  return [raster.data[i], raster.data[i + 1], raster.data[i + 2], raster.data[i + 3]];
}

/** How far apart two colours are, in the channel that differs most. The metric the whole gate is judged on. */
export function channelGap(a, b) {
  if (!a || !b) return 255;
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** `#rrggbb` or `rgba(r, g, b, a)` to [r, g, b, a]. What getComputedStyle answers for a token. */
export function parseColour(text) {
  const s = String(text || "").trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16), 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i.exec(s);
  if (rgb) return [Math.round(Number(rgb[1])), Math.round(Number(rgb[2])), Math.round(Number(rgb[3])), rgb[4] === undefined ? 1 : Number(rgb[4])];
  return null;
}

/** A colour with alpha, laid over an opaque one: what the browser shows for a translucent token. */
export function over(fg, bg) {
  if (!fg || !bg) return null;
  const a = fg[3] === undefined ? 1 : fg[3];
  return [0, 1, 2].map((i) => Math.round(a * fg[i] + (1 - a) * bg[i]));
}

/** WCAG relative luminance, for the ring-versus-disc contrast a reader's eye is actually doing. */
export function luminance(rgb) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

/** The contrast ratio between two colours: 1 means invisible, 21 means black on white. */
export function contrast(a, b) {
  if (!a || !b) return 1;
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** The colour that appears most often in a list of pixels, ties going to the first seen. */
export function modeColour(list) {
  const counts = new Map();
  for (const c of list) {
    if (!c) continue;
    const key = `${c[0]},${c[1]},${c[2]}`;
    const seen = counts.get(key);
    if (seen) seen.n += 1;
    else counts.set(key, { n: 1, rgb: [c[0], c[1], c[2]] });
  }
  let best = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best ? best.rgb : null;
}

/**
 * The disc, sampled.
 *
 * `dot` and `label` are page-space boxes (the dot's border box, and the text's ink box from a Range), `clip` is where
 * the raster starts in page space, `tokens` are the resolved theme colours for this state. Everything the gate asserts
 * is a number in the answer, so the report can quote the same values the gate judged.
 */
export function analyseDot({ raster, clip, dot, label, tokens }) {
  const data = raster.data;
  const cx = Math.round(dot.x - clip.x + dot.w / 2);
  const cy = Math.round(dot.y - clip.y + dot.h / 2);
  const radius = dot.w / 2;
  const stroke = Number(dot.border) > 0 ? Number(dot.border) : 1;
  // The stroke's inner edge, and the last row that is clear of its antialiasing: the sampler works in the disc's
  // inner area only, so a ring pixel can never be read as a stray one.
  const innerEdge = radius - stroke;
  const usable = innerEdge - 1.5;
  const lx0 = label ? Math.round(label.x - clip.x) : cx;
  const lx1 = label ? Math.round(label.x - clip.x + label.w) : cx;
  const ly0 = label ? Math.round(label.y - clip.y) : cy;
  const ly1 = label ? Math.round(label.y - clip.y + label.h) : cy;
  const inside = (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= (innerEdge - 0.5) ** 2;
  // The run of pixels the stripe test reads across the disc: nine wide, the connector's own columns in the middle.
  const runRange = (y, from, to, skipCentre) => {
    const run = [];
    for (let x = from; x <= to; x += 1) {
      if (skipCentre && Math.abs(x - cx) <= 1) continue;
      run.push(pixelAt(raster, x, y));
    }
    let range = 0;
    for (let c = 0; c < 3; c += 1) {
      const vals = run.map((p) => (p ? p[c] : 0));
      range = Math.max(range, Math.max(...vals) - Math.min(...vals));
    }
    return { range, run };
  };

  // ---- the disc's own colour: the modal pixel of the inner area, clear of the connector's columns ------------------
  const interior = [];
  for (let y = Math.floor(cy - usable); y <= Math.ceil(cy + usable); y += 1) {
    for (let x = Math.floor(cx - usable); x <= Math.ceil(cx + usable); x += 1) {
      if (!inside(x, y) || Math.abs(x - cx) <= 2) continue;
      interior.push(pixelAt(raster, x, y));
    }
  }
  const interiorRgb = modeColour(interior);

  // ---- THE STRIPE TEST. The disc either side of the connector, two pixels each side: far enough out to be clear of
  // a two-pixel line's own antialiasing, and far enough in to be clear of the ring's on the narrower two-pixel ring.
  // A row whose sides are one colour is a row clear of the label. The label's INK BAND is then every row between the
  // first and last row that showed ink, because a glyph has rows whose ink misses the side columns (the space between
  // "W" and the digit) and those must not be read as a clear row. On a clear row the whole five-pixel run through the
  // connector must be one colour too: if the line shows through the disc, the middle of that run is not the disc.
  const sidesAt = (y) => {
    const px = [pixelAt(raster, cx - 4, y), pixelAt(raster, cx - 3, y), pixelAt(raster, cx + 3, y), pixelAt(raster, cx + 4, y)];
    let range = 0;
    for (let c = 0; c < 3; c += 1) {
      const vals = px.map((p) => (p ? p[c] : 0));
      range = Math.max(range, Math.max(...vals) - Math.min(...vals));
    }
    return { range, px };
  };
  const candidates = [];
  for (let dy = 1; dy <= Math.floor(usable); dy += 1) {
    for (const y of [cy - dy, cy + dy]) {
      if (!inside(cx, y)) continue;
      candidates.push({ y, ...sidesAt(y) });
    }
  }
  const inked = candidates.filter((c) => c.range > 6).map((c) => c.y);
  const inkBand = inked.length ? { from: Math.min(...inked), to: Math.max(...inked) } : null;
  const stripeRows = [];
  const labelRows = [];
  for (const c of candidates) {
    const inBand = Boolean(inkBand) && c.y >= inkBand.from && c.y <= inkBand.to;
    if (c.range > 6 || inBand) {
      labelRows.push(c.y);
      continue;
    }
    const { range, run } = runRange(c.y, cx - 2, cx + 2, false);
    stripeRows.push({ y: c.y, range, sidesRange: c.range, sides: c.px, run });
  }
  stripeRows.sort((a, b) => a.y - b.y);

  // The connector's own two columns, on every usable row: how many pixels are not the disc.
  let strayPixels = 0;
  const stray = [];
  for (const row of stripeRows) {
    for (const x of [cx - 1, cx, cx + 1]) {
      if (!inside(x, row.y)) continue;
      const p = pixelAt(raster, x, row.y);
      if (p && channelGap(p, interiorRgb) > 12) {
        strayPixels += 1;
        if (stray.length < 6) stray.push({ x, y: row.y, rgb: p });
      }
    }
  }

  // ---- THE CONNECTOR AT BOTH EDGES. Sample two or three rows outside the ring, above and below, and take the pixel
  // that differs most from the disc: that is the line. It has to be there on both sides, in the state's colour.
  const edge = (y) => {
    const run = [];
    for (let x = cx - 2; x <= cx + 2; x += 1) run.push({ x, rgb: pixelAt(raster, x, y) });
    const sorted = run.filter((r) => r.rgb).sort((a, b) => channelGap(b.rgb, interiorRgb) - channelGap(a.rgb, interiorRgb));
    return sorted[0] || null;
  };
  const above = edge(cy - Math.round(radius) - 3);
  const below = edge(cy + Math.round(radius) + 3);
  const connector = tokens && tokens.connector ? tokens.connector : null;
  const connectorAbove = above ? above.rgb : null;
  const connectorBelow = below ? below.rgb : null;
  const gapAbove = connector && connectorAbove ? channelGap(connectorAbove, connector) : null;
  const gapBelow = connector && connectorBelow ? channelGap(connectorBelow, connector) : null;
  const edgesSay = Boolean(
    connectorAbove && connectorBelow && gapAbove !== null && gapAbove <= 6 && gapBelow !== null && gapBelow <= 6,
  );

  // ---- THE RING. The stroke's own colour is read at the LEFT and RIGHT cardinal points, where a one-pixel stroke is
  // aligned to the pixel grid and fully covered (the vertical connector crosses the ring at the top and bottom, which
  // is where it is excluded). All four cardinal points are measured for continuity: the ring has to be there, all the
  // way round, or the lane reads as broken.
  const ringish = (p) => p && interiorRgb && channelGap(p, interiorRgb) > 10;
  const ringBand = (theta) => {
    const out = [];
    for (let r = radius - stroke; r <= radius; r += 0.5) {
      out.push(pixelAt(raster, cx + Math.cos(theta) * r, cy + Math.sin(theta) * r));
    }
    return out.filter(Boolean);
  };
  const cardinalAt = (at, theta) => {
    const band = ringBand(theta);
    const best = band.sort((a, b) => channelGap(b, interiorRgb) - channelGap(a, interiorRgb))[0] || null;
    return { at, rgb: best, gap: channelGap(best, interiorRgb) };
  };
  const cardinals = [
    cardinalAt("top", -Math.PI / 2),
    cardinalAt("right", 0),
    cardinalAt("bottom", Math.PI / 2),
    cardinalAt("left", Math.PI),
  ];
  // The stroke's colour is the PUREST pixel of the annulus, with the connector's own columns excluded: a one-pixel
  // circle stroke is antialiased all the way round, so its mode is a blend, while the pixel furthest from the disc is
  // the stroke's own colour - which is what a reader's eye picks out and what the token says it should be.
  const annulus = [];
  for (let a = 0; a < 720; a += 1) {
    const theta = (a / 720) * Math.PI * 2;
    // The x of each sample in the band, so the connector's columns can be left out of the stroke's colour.
    for (let r = radius - stroke; r <= radius; r += 0.5) {
      const x = cx + Math.cos(theta) * r;
      if (Math.abs(x - cx) <= 2) continue;
      const p = pixelAt(raster, x, cy + Math.sin(theta) * r);
      if (ringish(p)) annulus.push(p);
    }
  }
  const ringRgb = annulus.sort((a, b) => channelGap(b, interiorRgb) - channelGap(a, interiorRgb))[0] || null;
  const ringComplete = cardinals.every((c) => ringish(c.rgb));
  const ringContrast = ringRgb && interiorRgb ? Number(contrast(ringRgb, interiorRgb).toFixed(2)) : 1;
  const ringVsToken = ringRgb && tokens && tokens.ring ? channelGap(ringRgb, tokens.ring) : null;

  return {
    centre: { x: cx, y: cy },
    radius,
    stroke,
    innerEdge,
    usable: Number(usable.toFixed(2)),
    interiorRgb,
    stripeRows,
    stripeMaxRange: stripeRows.length ? Math.max(...stripeRows.map((r) => r.range)) : null,
    stripePixels: strayPixels,
    straySample: stray,
    labelRows,
    labelBox: { lx0, lx1, ly0, ly1 },
    connectorAbove,
    connectorBelow,
    connectorGapAbove: gapAbove,
    connectorGapBelow: gapBelow,
    connectorAtBothEdges: edgesSay,
    ringRgb,
    ringCardinals: cardinals,
    ringComplete,
    ringContrast,
    ringVsTokenGap: ringVsToken,
  };
}

// ---- the gate, run only when this file is the program ---------------------------------------------------------------
async function main() {
  const watchdog = setTimeout(() => {
    try {
      process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing.\n`);
    } catch {
      /* nothing left to do */
    }
    process.exit(1);
  }, WATCHDOG_MS);

  const args = process.argv.slice(2);
  const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const shotsDir = argOf("--shots") ? path.resolve(argOf("--shots")) : null;
  const jsonFile = argOf("--json") ? path.resolve(argOf("--json")) : null;
  const baselineFile = argOf("--baseline") ? path.resolve(argOf("--baseline")) : null;
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });

  let failures = 0;
  let checks = 0;
  const check = (name, got, want) => {
    checks += 1;
    const pass = JSON.stringify(got) === JSON.stringify(want);
    if (!pass) failures += 1;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  };
  const ok = (name, cond, extra = "") => {
    checks += 1;
    if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
    else {
      failures += 1;
      console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
    }
  };
  const note = (s) => console.log(`      ${s}`);

  // ---- the sandbox: two projects, one worktree each, and a wave in every state --------------------------------------
  const sandbox = mkdtempSync(path.join(tmpdir(), "wag-wave-dot-"));
  const repos = path.join(sandbox, "repos");
  mkdirSync(repos, { recursive: true });
  const project = (name, tree) => {
    const dir = path.join(repos, name);
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "first"]);
    git(dir, ["worktree", "add", "-q", "-b", tree, path.join(dir, ".worktrees", tree)]);
    return path.join(dir, ".worktrees", tree);
  };
  const treeA = project("wave-dot-a", "dot-a");
  const treeB = project("wave-dot-b", "dot-b");
  const wavesFile = path.join(sandbox, "logs", "waves.json");

  const panel = await startPanel({
    dir: sandbox,
    config: {
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: 3600,
      scanMode: "all",
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      wavesFile,
    },
  });
  const base = panel.base;
  const GET = async (p) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  const run = { at: new Date().toISOString(), branch: null, widths: [], dots: [], failures: 0, checks: 0 };

  try {
    console.log(`sandbox: ${base}`);
    console.log(`panel pid: ${panel.pid}`);

    await waitForState(
      base,
      (s) => {
        const rows = s.projects.flatMap((p) => (p.worktrees || []).map((w) => w.path));
        return [treeA, treeB].every((p) => rows.some((r) => r.replace(/\\/g, "/").toLowerCase() === p.replace(/\\/g, "/").toLowerCase()));
      },
      "the two worktrees are on the board",
      { timeout: 120_000 },
    );

    // ---- the fixture -------------------------------------------------------------------------------------------
    console.log("\n== seed ==");
    const tiered = await post(base, "/api/settings/initiative-tier", { body: { tier: "remove" } });
    check("the initiative tier leaves create free", tiered.status, 200);

    const makeInitiative = async (title) => {
      const made = await post(base, "/api/initiatives", { body: { title, description: title } });
      if (made.status !== 201) throw new Error(`creating "${title}" answered HTTP ${made.status}: ${made.json?.error || made.text || ""}`);
      return made.json?.initiative?.id;
    };
    const initA = await makeInitiative("The next wave is surfaced");
    const initB = await makeInitiative("Every state at once");
    const initC = await makeInitiative("A wave a person closed");

    // The panel seeds assistant-1 on its first boot. A state read can land while the boot pass is still building the
    // board, so the answer is retried for a few seconds rather than trusted once.
    let assistant = (await GET("/api/state")).json?.assistant?.assistants?.[0];
    for (let i = 0; !assistant?.id && i < 20; i += 1) {
      await sleep(250);
      assistant = (await GET("/api/state")).json?.assistant?.assistants?.[0];
    }
    ok("the panel seeded an assistant", Boolean(assistant?.id), String(assistant?.id || ""));
    if (!assistant?.id) throw new Error("the sandbox has no assistant to file tasks on");
    const add = async (title, worktree, projectName) => {
      const out = await post(base, "/api/assistant/queue", { body: { assistantId: assistant.id, action: "add", title, worktree, project: projectName } });
      if (out.status !== 200) throw new Error(`filing ${title} answered HTTP ${out.status}: ${out.json?.error || out.text || ""}`);
      const tasks = (await GET(`/api/assistant/queue?assistantId=${assistant.id}`)).json?.queue?.tasks || [];
      const task = tasks.find((t) => t.title === title);
      if (!task) throw new Error(`filed ${title} is not in the queue`);
      return task;
    };
    const setState = async (id, next) => {
      const out = await post(base, "/api/assistant/queue", { body: { assistantId: assistant.id, action: "state", id, state: next } });
      if (out.status !== 200) throw new Error(`setting #${id} ${next} answered HTTP ${out.status}: ${out.json?.error || out.text || ""}`);
    };

    // One task per wave, named after the wave so a failure says which one.
    const tasks = {
      a1: await add("A1 the closed wave", treeA, "wave-dot-a"),
      a2: await add("A2 the surfaced next wave", treeB, "wave-dot-b"),
      b1: await add("B1 running and current", treeA, "wave-dot-a"),
      b2: await add("B2 running, not current", treeB, "wave-dot-b"),
      b3: await add("B3 the done wave", treeA, "wave-dot-a"),
      b5: await add("B5 the wave not entered", treeB, "wave-dot-b"),
      b6: await add("B6 the wave that cannot tell", treeA, "wave-dot-a"),
      b7: await add("B7 the parked wave", treeB, "wave-dot-b"),
      b8: await add("B8 the ready wave", treeA, "wave-dot-a"),
      c1: await add("C1 the abandoned wave", treeB, "wave-dot-b"),
    };
    await setState(tasks.a1.id, "done");
    await setState(tasks.b1.id, "running");
    await setState(tasks.b2.id, "running");
    await setState(tasks.b3.id, "done");
    await setState(tasks.b7.id, "parked");

    // Membership and the one abandonment are the row's own fields; stamped here exactly as a write route would.
    const queueFile = path.join(sandbox, "logs", "assistants", assistant.id, "queue.json");
    const queued = readQueueFile(queueFile);
    if (queued.error) throw new Error(`the queue cannot be read: ${queued.error}`);
    const waveOf = {
      [tasks.a1.id]: "a-closed",
      [tasks.a2.id]: "a-surfaced",
      [tasks.b1.id]: "b-running-current",
      [tasks.b2.id]: "b-running-other",
      [tasks.b3.id]: "b-done",
      [tasks.b5.id]: "b-unentered",
      [tasks.b6.id]: "b-unknown",
      [tasks.b7.id]: "b-blocked",
      [tasks.b8.id]: "b-ready",
      [tasks.c1.id]: "c-abandoned",
    };
    writeQueueFile(
      queueFile,
      queued.tasks.map((t) => {
        const next = { ...t, waveId: waveOf[t.id] || t.waveId || null };
        if (t.id === tasks.c1.id) next.abandoned = { reason: "superseded by #284", at: new Date().toISOString(), by: "reader" };
        return next;
      }),
      queued.nextId,
    );

    const wave = (id, initiativeId, position, title, extra = {}) => ({ id, initiativeId, position, title, auto: false, ...extra });
    writeFileSync(
      wavesFile,
      `${JSON.stringify(
        {
          version: 1,
          byInitiative: {
            // W1 closed with auto off, so W2 is the wave the card SURFACES as the next one to open - and, with nothing
            // running, the current one: the exact disc the reader's screenshot caught the connector through.
            [initA]: [
              wave("a-closed", initA, 1, "The wave that closed"),
              wave("a-surfaced", initA, 2, "The wave a person is owed"),
            ],
            // Every state at once. W1 runs, so it is current; W2 runs too and is not; nothing else can be current.
            [initB]: [
              wave("b-running-current", initB, 1, "The wave that is running"),
              wave("b-running-other", initB, 2, "A second running wave"),
              wave("b-done", initB, 3, "The wave that is done"),
              wave("b-empty", initB, 4, "The wave nobody joined"),
              wave("b-unentered", initB, 5, "The wave not entered", { entryGate: { check: "commits", min: 3 } }),
              wave("b-unknown", initB, 6, "The wave that cannot tell", { entryGate: { check: "pr-open" } }),
              wave("b-blocked", initB, 7, "The wave held by a park"),
              wave("b-ready", initB, 8, "The wave that is ready"),
            ],
            // A wave closed as abandoned: its exit gate reads a named abandonment rather than a landing.
            [initC]: [wave("c-abandoned", initC, 1, "The wave a person abandoned", { exitGate: { check: "pr-open" } })],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // The route's own answer for every wave, so the paint is compared with the fold rather than eyeballed.
    const served = {};
    for (const [name, id] of [["A", initA], ["B", initB], ["C", initC]]) {
      const doc = await GET(`/api/waves?initiative=${id}`);
      check(`the ${name} wave route answers`, doc.status, 200);
      for (const w of doc.json?.waves || []) served[w.id] = w;
    }
    const wanted = {
      "a-closed": "done",
      "a-surfaced": "ready",
      "b-running-current": "running",
      "b-running-other": "running",
      "b-done": "done",
      "b-empty": "empty",
      "b-unentered": "unentered",
      "b-unknown": "unknown",
      "b-blocked": "blocked",
      "b-ready": "ready",
      "c-abandoned": "abandoned",
    };
    for (const [id, state] of Object.entries(wanted)) {
      check(`wave ${id} folds to ${state}`, served[id]?.state, state);
    }
    ok(
      "the surfaced wave is the one the card says a person is owed",
      Boolean(served["a-surfaced"]?.autoOpen?.surface),
      String(served["a-surfaced"]?.autoOpen?.surface || "(no surface)"),
    );

    const baseline = baselineFile ? JSON.parse(readFileSync(baselineFile, "utf8")) : null;
    if (baseline) note(`baseline: ${path.basename(baselineFile)} written ${baseline.at}`);

    const playwright = loadPlaywright();
    if (!playwright) {
      console.log(notRun("the wave station's disc at two pane widths", "playwright is not installed for this node (see tools/browser.mjs)"));
      failures += 1;
    } else {
      let shotNo = 0;
      await withBrowser(
        async ({ page, pageErrors, consoleErrors }) => {
          // Two pane widths, in the two dock settings the panel actually draws: the default 480px rail (a ~480px
          // container, below the Initiatives container query) and a wide 1100px rail at a 2200px window (where the
          // query takes over). The container's own measured width is printed, never assumed.
          for (const pane of [
            { name: "dock", viewport: { width: 1440, height: 900 }, rail: 480 },
            { name: "wide", viewport: { width: 2200, height: 1000 }, rail: 1100 },
          ]) {
            console.log(`\n== ${pane.name} ==  viewport ${pane.viewport.width}x${pane.viewport.height}, rail ${pane.rail}px`);
            await page.setViewportSize(pane.viewport);
            await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await page.evaluate(
              ({ rail }) => {
                localStorage.setItem("wm.assistantOpen", "true");
                localStorage.setItem("wm.assistantWidth", String(rail));
              },
              { rail: pane.rail },
            );
            await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
            await page.waitForSelector("#projects", { timeout: 30_000 });
            if (!(await page.evaluate(() => {
              const el = document.getElementById("assistant");
              return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
            }))) {
              await page.click("#btn-assistant");
            }
            await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
            await page.click('#as-tabs [data-as-tab="initiatives"]');
            await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
            await page.waitForSelector("#as-initiatives [data-init-card]", { timeout: 30_000 });

            // Every card open, so every wave's station is painted.
            for (const id of [initA, initB, initC]) {
              const card = `#as-initiatives [data-init-card="${id}"]`;
              await page.waitForSelector(card, { timeout: 20_000 });
              const open = await page.evaluate((sel) => Boolean(document.querySelector(`${sel} .init-wavefold`)), card);
              if (!open) await page.click(`${card} [data-init-card-toggle]`);
              await page.waitForSelector(`${card} .init-wavefold`, { timeout: 20_000 });
            }
            await page.waitForSelector('#as-initiatives [data-wave-id="b-running-current"] .wave-member', { timeout: 20_000 });

            const paneWidth = await page.evaluate(() => Number(document.getElementById("as-initiatives").getBoundingClientRect().width.toFixed(1)));
            const tokens = await page.evaluate(() => {
              const el = document.getElementById("as-initiatives");
              const cs = getComputedStyle(el);
              const pick = (name) => cs.getPropertyValue(name).trim();
              return {
                ready: pick("--tab-ready"),
                run: pick("--tab-run"),
                accent: pick("--tab-accent"),
                warn: pick("--tab-warn"),
                bad: pick("--tab-bad"),
                lineStrong: pick("--tab-line-strong"),
                surface: pick("--tab-surface"),
                runBg: pick("--tab-run-bg"),
                runLine: pick("--tab-run-line"),
                warnLine: pick("--tab-warn-line"),
                badLine: pick("--tab-bad-line"),
              };
            });
            const stateColour = {
              running: tokens.run,
              ready: tokens.ready,
              done: tokens.accent,
              unknown: tokens.warn,
              blocked: tokens.warn,
              abandoned: tokens.bad,
              empty: tokens.lineStrong,
              unentered: tokens.lineStrong,
            };
            // The ring's own token is NOT the connector's: the stroke is drawn from the `-line` variants where the
            // state has one (public/style.css:5542-5547), and those carry an alpha.
            const stateRing = {
              running: tokens.runLine,
              ready: tokens.lineStrong,
              done: tokens.runLine,
              unknown: tokens.warnLine,
              blocked: tokens.warnLine,
              abandoned: tokens.badLine,
              empty: tokens.lineStrong,
              unentered: tokens.lineStrong,
            };
            note(`#as-initiatives is ${paneWidth}px wide; tokens ready ${tokens.ready}, run ${tokens.run}, accent ${tokens.accent}, run-bg ${tokens.runBg}`);
            run.widths.push({ pane: pane.name, viewport: pane.viewport, rail: pane.rail, paneWidth });

            const painted = await page.evaluate(() =>
              [...document.querySelectorAll("#as-initiatives .wave-row")].map((row) => {
                const dot = row.querySelector(".wave-pos");
                const rect = dot.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(dot);
                const label = range.getBoundingClientRect();
                const cs = getComputedStyle(dot);
                return {
                  waveId: row.getAttribute("data-wave-id"),
                  state: row.getAttribute("data-wave-state"),
                  current: row.getAttribute("data-wave-current") === "true",
                  surfaced: Boolean(row.querySelector("[data-wave-next]")),
                  surfaceText: row.querySelector("[data-wave-next]")?.getAttribute("data-wave-next") || null,
                  position: dot.textContent.trim(),
                  dot: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                  label: { x: label.x, y: label.y, w: label.width, h: label.height },
                  border: Number.parseFloat(cs.borderTopWidth) || 1,
                  background: cs.backgroundColor,
                  backgroundImage: cs.backgroundImage,
                  zIndex: cs.zIndex,
                };
              }),
            );
            check(`at the ${pane.name} pane every seeded wave has a station`, painted.length, Object.keys(wanted).length);

            for (const dot of painted) {
              const sel = `#as-initiatives [data-wave-id="${dot.waveId}"] .wave-pos`;
              await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), sel);
              await sleep(120);
              // Measured AFTER the scroll: the screenshot is clipped from these numbers, so a stale box would sample
              // the wrong rows, and a stale label box would let the glyph through as if it were the connector.
              const fresh = await page.evaluate((s) => {
                const el = document.querySelector(s);
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(el);
                const label = range.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return {
                  box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                  label: { x: label.x, y: label.y, w: label.width, h: label.height },
                  border: Number.parseFloat(cs.borderTopWidth) || 1,
                  background: cs.backgroundColor,
                  backgroundImage: cs.backgroundImage,
                  zIndex: cs.zIndex,
                };
              }, sel);
              if (!fresh || !fresh.box.w || !fresh.box.h) {
                ok(`at the ${pane.name} pane ${dot.waveId} has a measurable box`, false);
                continue;
              }
              const pad = 10;
              const clip = {
                x: Math.max(0, Math.round(fresh.box.x - pad)),
                y: Math.max(0, Math.round(fresh.box.y - pad)),
                width: Math.round(fresh.box.w + pad * 2),
                height: Math.round(fresh.box.h + pad * 2),
              };
              const png = await page.screenshot({ clip });
              const file = shotsDir ? path.join(shotsDir, `${String((shotNo += 1)).padStart(2, "0")}-${pane.name}-${dot.waveId}.png`) : null;
              if (file) writeFileSync(file, png);
              const raster = decodePng(png);
              // The page box and the clip are both CSS px; the raster is device-px. At dpr 1 they are the same.
              const scale = raster.width / clip.width;
              const connectorToken = stateColour[dot.state];
              const ringToken = dot.current ? tokens.run : stateRing[dot.state];
              const analysis = analyseDot({
                raster,
                clip: { x: clip.x, y: clip.y },
                dot: { ...fresh.box, border: fresh.border },
                label: fresh.label,
                tokens: { connector: parseColour(connectorToken), ring: parseColour(ringToken) },
              });
              // What the ring's token should LOOK like: a translucent stroke over the disc's own fill.
              const ringExpected = over(parseColour(ringToken), analysis.interiorRgb);
              const record = {
                pane: pane.name,
                paneWidth,
                waveId: dot.waveId,
                position: dot.position,
                state: dot.state,
                current: dot.current,
                surfaced: dot.surfaced,
                surfaceText: dot.surfaceText,
                background: fresh.background,
                backgroundImage: fresh.backgroundImage,
                zIndex: fresh.zIndex,
                border: fresh.border,
                rasterScale: scale,
                // The shot's NAME, not its path: the run writes shots wherever --shots points, and a drive-letter path in
                // a committed run names one machine's scratch folder and nothing a reader can open.
                shot: file ? path.basename(file) : null,
                ...analysis,
                // The raw pixels of every sampled row are not shipped: the run's numbers are, and the shot beside them
                // is what a reader re-samples.
                stripeRows: analysis.stripeRows.map(({ y, range, sidesRange }) => ({ y, range, sidesRange })),
                connectorToken,
                ringToken,
                ringExpected,
                connectorGapToken: channelGap(parseColour(connectorToken), analysis.connectorAbove),
                ringGapToken: channelGap(ringExpected, analysis.ringRgb),
              };
              run.dots.push(record);

              const label = `${pane.name} ${dot.position} ${dot.waveId} (${dot.state}${dot.current ? ", current" : ""}${dot.surfaced ? ", surfaced" : ""})`;
              note(
                `${label}: disc rgb(${analysis.interiorRgb?.join(",")}), ring rgb(${analysis.ringRgb?.join(",")}) ${analysis.ringContrast}:1, ` +
                  `stripe max range ${analysis.stripeMaxRange} over ${analysis.stripeRows.length} rows, stray ${analysis.stripePixels}px, ` +
                  `connector above rgb(${analysis.connectorAbove?.join(",")}) below rgb(${analysis.connectorBelow?.join(",")})`,
              );
              // THE ONE CLAIM: no column of the connector inside the disc, on any row the label does not cover.
              ok(`${label}: no connector stripe inside the disc`, analysis.stripePixels === 0 && analysis.stripeMaxRange !== null && analysis.stripeMaxRange <= 6, `stray ${analysis.stripePixels}px, range ${analysis.stripeMaxRange}`);
              ok(`${label}: the disc's inner area was sampled on rows clear of the label`, analysis.stripeRows.length >= 2, `${analysis.stripeRows.length} rows`);
              // The line still reaches both edges of the ring, in the state's own colour.
              ok(`${label}: the connector meets the ring above and below`, analysis.connectorAtBothEdges, `above gap ${analysis.connectorGapAbove}, below gap ${analysis.connectorGapBelow}`);
              ok(`${label}: the connector is painted in the state's colour at the ring`, record.connectorGapToken <= 6, `gap ${record.connectorGapToken}`);
              // The ring is still there, all the way round, and its own colour is the state's.
              ok(`${label}: the ring is continuous at four cardinal points`, analysis.ringComplete, JSON.stringify(analysis.ringCardinals.map((c) => `${c.at} ${c.gap}`)));
              ok(`${label}: the ring is the state's own colour`, record.ringGapToken <= 8, `gap ${record.ringGapToken} of ${ringToken}`);
              ok(`${label}: the ring reads against the disc`, analysis.ringContrast >= 1.2, `${analysis.ringContrast}:1`);
              // NOT A RESTYLE: with a baseline, every colour the dot had is still the colour it has.
              if (baseline) {
                const before = (baseline.dots || []).find((d) => d.pane === pane.name && d.waveId === dot.waveId);
                if (!before) {
                  ok(`${label}: the baseline has this dot`, false, "missing from the baseline run");
                } else {
                  ok(
                    `${label}: the disc keeps the colour it had (within 2 per channel)`,
                    channelGap(before.interiorRgb, analysis.interiorRgb) <= 2,
                    `before rgb(${before.interiorRgb?.join(",")}) after rgb(${analysis.interiorRgb?.join(",")})`,
                  );
                  ok(
                    `${label}: the ring keeps its colour and contrast`,
                    channelGap(before.ringRgb, analysis.ringRgb) <= 2 && analysis.ringContrast >= before.ringContrast - 0.05,
                    `ring before ${before.ringContrast}:1 after ${analysis.ringContrast}:1`,
                  );
                }
              }
            }
          }

          console.log("\n== health ==");
          check("no page errors", pageErrors.map(String), []);
          check("no console errors", consoleErrors.map(String), []);
        },
        { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
      );
    }
  } catch (err) {
    failures += 1;
    console.error(`\nFAIL  the run threw: ${err && err.stack ? err.stack : err}`);
    try {
      console.error(panel.log().split("\n").slice(-20).join("\n"));
    } catch {
      /* the log is a courtesy */
    }
  } finally {
    await panel.stop();
    rmSync(sandbox, { recursive: true, force: true });
    clearTimeout(watchdog);
  }

  run.failures = failures;
  run.checks = checks;
  if (jsonFile) {
    mkdirSync(path.dirname(jsonFile), { recursive: true });
    writeFileSync(jsonFile, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    console.log(`run written to ${jsonFile}`);
  }
  console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed${shotsDir ? `; shots in ${shotsDir}` : ""}`);
  process.exit(failures === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
