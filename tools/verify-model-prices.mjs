// The model menu's price and coding-rating columns, and the one control that regenerates them.
//
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-model-prices.mjs
//
// The New-agent card's model dropdown named a model and nothing else, so choosing between two ids that
// cost the same meant leaving the board. Each row now carries what the shipped CLI model picker already
// shows: the input and output price per million tokens and Artificial Analysis' coding index rescaled to
// 0-10. The numbers come from the gateway's own model inventory (GET /api/model/options — the same
// `_apply_pricing` the CLI picker patch decorates its rows from), and the panel keeps its own copy so
// opening the menu is a file read and can never wait on a cold provider. A Settings control regenerates
// that copy: it makes the gateway re-fetch every provider's live model list — rewriting
// provider_models_cache.json, the file `hermes model --refresh` writes and the file the menu lists from —
// and rebuilds the panel's cache from the answer, having deleted its own first.
//
// Everything below happens in a sandbox of its own: a throwaway HERMES_HOME, its own PANEL_CONFIG with
// its own port and its own logs, and an apiServer pointed at a STAND-IN gateway this script runs. The
// live panel on 7331 and the live gateway on 8642 are never touched, and the whole temp root is deleted
// at the end.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven        the formatter itself, against the gateway's own strings: "$10.00" kept, a router's
//                 "-1000000" / "$-1000000.00" / "?" refused, "free" kept, a code of "0" or "12" refused
//   driven        a real sandbox panel over that stand-in gateway: /api/models answers from the panel's
//                 own cache file with ZERO gateway calls on the read path, the sentinel model renders as
//                 a bare id, the unrated model carries a price and no rating, and a provider the gateway
//                 priced nothing for gets no pricing at all
//   driven        the background warm: a panel booted with no price cache fires exactly ONE gateway
//                 regeneration and its next /api/models carries prices
//   driven        POST /api/models/refresh: the stand-in gateway receives exactly one call, and it is
//                 `?refresh=true`; the reply's before/after row counts and file mtimes for BOTH files are
//                 read off the answer, provider_models_cache.json is re-written by the gateway on the way
//                 through, and a hand-planted entry in the panel's own cache is gone afterwards — which is
//                 the delete, proved rather than asserted
//   driven        the browser (Playwright, headless Chromium): the option text carries "$x in / $y out ·
//                 code n.n", the sentinel row carries neither, and pressing the Settings control refills
//                 the dropdown from the regenerated answer
//   inspected     that the JS/CSS are served from disk per request, so the browser half rides a plain
//                 reload — read off server.js, not measured here
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a
// directory holding node_modules/playwright, or the package itself); without one the script says
// BROWSER-HALF-NOT-RUN and exits non-zero rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const require = createRequire(import.meta.url);

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (!good) failures += 1;
  console.log(`${good ? "PASS" : "FAIL"}  ${name}${good ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 60_000, stepMs = 400, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

// The models this sandbox offers, and the two answers the stand-in gateway gives. A is what the
// background warm receives; B is what the deliberate press receives, and it is deliberately DIFFERENT —
// different numbers, one fewer priced row, one more model — so "regenerated" cannot be confused with
// "re-read the same bytes". acme/sentinel is what a router serves for "not priced".
const MODELS_A = ["acme/priced-rated", "acme/priced-only", "acme/sentinel", "acme/unpriced"];
const MODELS_B = [...MODELS_A, "acme/new-model"];
const PRICING_A = {
  "acme/priced-rated": { input: "$10.00", output: "$50.00", coding: "7.7" },
  "acme/priced-only": { input: "$1.00", output: "$2.00" },
  "acme/sentinel": { input: "$-1000000.00", output: "$-1000000.00" },
};
const PRICING_B = {
  "acme/priced-rated": { input: "$11.00", output: "$91.00", coding: "8.1" },
  "acme/sentinel": { input: "$-1000000.00", output: "$-1000000.00" },
  "acme/new-model": { input: "$2.00", output: "$4.00", coding: "9.9" },
};
// The third regeneration — the one the BROWSER's press gets — is a third distinct answer, so the
// dropdown visibly refills rather than happening to already show the same strings.
const PRICING_C = {
  "acme/priced-rated": { input: "$7.00", output: "$70.00", coding: "5.5" },
  "acme/unpriced": { input: "$0.50", output: "$0.75" },
};

// ---- the stand-in gateway --------------------------------------------------------------------
const gateway = { calls: [], port: 0 };
async function startGateway(homeDir) {
  gateway.port = await freePort();
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${gateway.port}`);
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname !== "/api/model/options") return send(404, { error: "not found" });
    const refresh = url.searchParams.get("refresh") === "true";
    gateway.calls.push({ refresh, auth: req.headers.authorization || null, at: Date.now() });
    let models = MODELS_A;
    let pricing = PRICING_A;
    if (refresh) {
      const n = gateway.calls.filter((c) => c.refresh).length;
      // Every regeneration rewrites provider_models_cache.json, exactly as the real route does; the
      // second one grows the list and the third shrinks it again, so a row-count change is part of
      // the proof each time.
      models = n === 1 ? MODELS_A : n === 2 ? MODELS_B : MODELS_A;
      pricing = n === 1 ? PRICING_A : n === 2 ? PRICING_B : PRICING_C;
      writeFileSync(
        path.join(homeDir, "provider_models_cache.json"),
        JSON.stringify({
          openrouter: { fp: "sandbox-fp", at: Date.now() / 1000, models },
          copilot: { fp: "sandbox-fp", at: Date.now() / 1000, models: ["copilot/one", "copilot/two"] },
        }),
        "utf8",
      );
    }
    send(200, {
      model: "acme/priced-rated",
      provider: "openrouter",
      providers: [
        { slug: "openrouter", models, pricing },
        { slug: "copilot", models: ["copilot/one", "copilot/two"] }, // nothing priced: no key at all
      ],
    });
  });
  await new Promise((resolve) => server.listen(gateway.port, "127.0.0.1", resolve));
  gateway.server = server;
  gateway.url = `http://127.0.0.1:${gateway.port}`;
}
const stopGateway = () => new Promise((resolve) => (gateway.server ? gateway.server.close(resolve) : resolve()));

// ---- the browser half ------------------------------------------------------------------------
function loadPlaywright() {
  const roots = [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd()].filter(Boolean);
  for (const root of roots) {
    try {
      return require(path.join(root, "node_modules", "playwright"));
    } catch {
      /* not there */
    }
    try {
      return require(root);
    } catch {
      /* not there */
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

// ---- the sandbox -----------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-model-prices-"));
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const repo = path.join(dir, "scan-root", "sandbox-repo");
const logDir = path.join(configDir, "logs");
for (const d of [home, configDir, logDir, repo]) mkdirSync(d, { recursive: true });
const modelsCacheFile = path.join(home, "provider_models_cache.json");
const pricingFile = path.join(logDir, "model-prices.json");

const panelLog = [];
let panel = null;
let base = "";

const writeConfig = (port, gatewayUrl) =>
  writeFileSync(
    path.join(configDir, "config.json"),
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [path.join(dir, "scan-root")],
        refreshSeconds: 30,
        worktreeSeconds: 30,
        midSeconds: 60,
        dormantSeconds: 120,
        slowSeconds: 120,
        fetchSeconds: 3600,
        threads: 1,
        scanMode: "all",
        defaultCwd: repo,
        projectsCacheFile: path.join(logDir, "projects.json"),
        jobsFile: path.join(logDir, "jobs.json"),
        assistantFile: path.join(logDir, "assistant.json"),
        modelPricingFile: pricingFile,
        apiServer: { url: gatewayUrl, key: "sandbox-key" },
        assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

const startPanel = async (configPath) => {
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
};
const stopPanel = async () => {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.kill();
  const gone = await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 15_000, what: "the panel to exit" });
  // A node process can outlive a polite kill on Windows and hold this script's event loop open with its
  // stdio pipes; take the tree down hard instead and release them either way.
  if (!gone && p.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
    await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 8_000, what: "the panel to be gone after taskkill" });
  }
  p.stdout?.destroy();
  p.stderr?.destroy();
  await sleep(300);
};
const api = async (route, body, method) => {
  const res = await fetch(`${base}${route}`, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const models = () => api("/api/models").then((r) => r.body);
const fileFacts = (file) => {
  try {
    const st = statSync(file);
    return { exists: true, mtime: Math.round(st.mtimeMs) };
  } catch {
    return { exists: false, mtime: null };
  }
};

// ---- the phases ------------------------------------------------------------------------------
async function unitPhase() {
  const m = await import("../lib/hermes-models.js");
  console.log("\n== the formatter, against the gateway's own strings ==");
  check("\"$10.00\" is a price", m.cleanPrice("$10.00"), "$10.00");
  check("\"free\" survives as itself", m.cleanPrice("free"), "free");
  check("a router's \"-1000000\" is refused", m.cleanPrice("-1000000"), "");
  check("and so is \"$-1000000.00\"", m.cleanPrice("$-1000000.00"), "");
  check("and the gateway's own \"?\" marker", m.cleanPrice("?"), "");
  check("an empty side is empty", m.cleanPrice(""), "");
  check("a rating of 7.7 is kept", m.cleanCoding("7.7"), "7.7");
  check("0 is not a rating", m.cleanCoding("0"), "");
  check("neither is 12 (the scale is 0-10)", m.cleanCoding("12"), "");
  check("a negative is not a rating", m.cleanCoding("-3"), "");
  check("a row of only sentinels is dropped whole", m.cleanPriceEntry({ input: "$-1000000.00", output: "$-1000000.00" }), null);
  check("a real row keeps both sides and the rating", m.cleanPriceEntry({ input: "$10.00", output: "$50.00", coding: "7.7" }), {
    input: "$10.00",
    output: "$50.00",
    coding: "7.7",
  });
  check("one side missing renders as the gateway's \"?\"", m.cleanPriceEntry({ input: "$1.00", output: "" }), { input: "$1.00", output: "?" });
  const built = m.buildPricingCache({ providers: [{ slug: "openrouter", pricing: { ...PRICING_A } }] }, "http://stub");
  check("the cache is keyed by provider slug and drops the sentinel", Object.keys(built.providers.openrouter).sort(), ["acme/priced-only", "acme/priced-rated"]);
  check("and counts what it kept", [built.pricedCount, built.ratedCount], [2, 1]);
}

async function warmPhase() {
  console.log("\n== a panel with no prices yet: the read is a file read, and the warm fills it ==");
  const first = await models();
  check("the menu answers with the models the gateway file lists", first.count, 6);
  check("and with no prices at all, because none are cached", [first.pricedCount, first.ratedCount], [0, 0]);
  ok("no provider carries a pricing map", first.providers.every((p) => !p.pricing), JSON.stringify(first.providers.map((p) => [p.id, Boolean(p.pricing)])));

  ok(
    "the background warm reaches the gateway exactly once, and asks it to regenerate",
    await waitFor(() => gateway.calls.length === 1 && gateway.calls[0].refresh === true, { what: "the warm's regeneration" }),
    JSON.stringify(gateway.calls.map((c) => c.refresh)),
  );
  check("the warm authenticated with the configured key", gateway.calls[0].auth, "Bearer sandbox-key");
  ok("the warm deleted and rewrote the panel's own cache file", fileFacts(pricingFile).exists, JSON.stringify(fileFacts(pricingFile)));

  const second = await models();
  check("the next read carries the prices it stored", [second.pricedCount, second.ratedCount], [2, 1]);
  check("and no further call was made", gateway.calls.length, 1);
  ok("every gateway call so far was a regeneration — the read path itself never fetched", gateway.calls.every((c) => c.refresh === true));
  const openrouter = second.providers.find((p) => p.id === "openrouter");
  check("the priced-and-rated row", openrouter.pricing["acme/priced-rated"], { input: "$10.00", output: "$50.00", coding: "7.7" });
  check("the priced-but-unrated row keeps its price and gains no rating", openrouter.pricing["acme/priced-only"], { input: "$1.00", output: "$2.00" });
  ok("the sentinel-priced row is absent, not negative", openrouter.pricing["acme/sentinel"] === undefined, JSON.stringify(openrouter.pricing));
  ok("a model nothing was priced for is absent too", openrouter.pricing["acme/unpriced"] === undefined);
  ok("a provider nothing was priced for carries no pricing map", !second.providers.find((p) => p.id === "copilot")?.pricing);
}

async function refreshPhase() {
  console.log("\n== the Settings press: regenerated, not re-read ==");
  await sleep(250); // so the two mtimes cannot land in the same write tick
  // Plant a row the gateway will not send back: if it survives the press, the panel merged instead of
  // rebuilding, and the whole claim collapses.
  const planted = readJson(pricingFile);
  planted.providers.openrouter["bogus/planted"] = { input: "$99.00", output: "$99.00" };
  writeFileSync(pricingFile, JSON.stringify(planted), "utf8");
  ok("a hand-planted row is in the panel's cache before the press", Boolean(readJson(pricingFile).providers.openrouter["bogus/planted"]));

  const callsBefore = gateway.calls.length;
  const res = await api("/api/models/refresh", {});
  check("the press is accepted", res.status, 200);
  const d = res.body;
  check("and the gateway saw exactly one more call", gateway.calls.length - callsBefore, 1);
  check("which asked for the regeneration", gateway.calls.at(-1).refresh, true);

  note(`provider_models_cache.json: ${d.before?.models?.rows} rows / ${d.before?.models?.providers} providers @ ${d.before?.models?.mtimeIso} → ${d.after?.models?.rows} rows / ${d.after?.models?.providers} providers @ ${d.after?.models?.mtimeIso}`);
  note(`model-prices.json:            ${d.before?.pricing?.priced} priced rows @ ${d.before?.pricing?.mtimeIso} → ${d.after?.pricing?.priced} priced rows @ ${d.after?.pricing?.mtimeIso}`);
  ok("the gateway's own provider cache changed", d.after.models.mtime > d.before.models.mtime, `${d.before.models.mtime} → ${d.after.models.mtime}`);
  check("and it grew by the model the gateway added", [d.before.models.rows, d.after.models.rows], [6, 7]);
  ok("the panel's cache file was rewritten", d.after.pricing.mtime > d.before.pricing.mtime, `${d.before.pricing.mtimeIso} → ${d.after.pricing.mtimeIso}`);
  check("the planted row is counted before the press and gone after it", [d.before.pricing.priced, d.after.pricing.priced], [3, 2]);

  const onDisk = readJson(pricingFile);
  ok("the planted row is GONE — the cache was busted, not merged", onDisk.providers.openrouter["bogus/planted"] === undefined, JSON.stringify(Object.keys(onDisk.providers.openrouter)));
  check("and the freshly fetched rows are what is in the file", Object.keys(onDisk.providers.openrouter).sort(), ["acme/new-model", "acme/priced-rated"]);
  check("the sentinel from this answer was refused on the way in", onDisk.providers.openrouter["acme/sentinel"], undefined);

  const after = await models();
  check("the menu now lists the model the gateway added", after.count, 7);
  const openrouter = after.providers.find((p) => p.id === "openrouter");
  check("with the regenerated price for the rated row", openrouter.pricing["acme/priced-rated"], { input: "$11.00", output: "$91.00", coding: "8.1" });
  ok("the row the new answer stopped pricing lost its price", !openrouter.pricing["acme/priced-only"], JSON.stringify(openrouter.pricing["acme/priced-only"]));
  check("and the added model arrived with its own", openrouter.pricing["acme/new-model"], { input: "$2.00", output: "$4.00", coding: "9.9" });
}

async function browserPhase(pw) {
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  const options = () => page.$$eval("#job-model option", (els) => els.map((o) => ({ value: o.value, text: o.textContent })));
  const textFor = async (id) => (await options()).find((o) => o.value === id)?.text || null;

  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    ok("the model menu is on the page", await waitFor(async () => (await options()).length > 1, { what: "the model options" }));

    console.log("\n== the dropdown's rows carry the price and the rating ==");
    const rated = await textFor("acme/priced-rated");
    ok("the rated row names its price per Mtok in and out", /in \/ \$91\.00 out/.test(rated || ""), rated);
    ok("and its coding rating out of ten", /code 8\.1/.test(rated || ""), rated);
    const sentinel = await textFor("acme/sentinel");
    ok("the sentinel row shows no number at all", sentinel === "acme/sentinel", JSON.stringify(sentinel));
    ok("definitely no negative price anywhere in the menu", (await options()).every((o) => !/-1000000|-1000000\.00/.test(o.text)));
    ok("the unpriced row is a bare id too", (await textFor("acme/unpriced")) === "acme/unpriced");
    ok("the added model carries both columns", /in \/ \$4\.00 out/.test((await textFor("acme/new-model")) || ""), await textFor("acme/new-model"));
    ok(
      "the select explains its own units on hover",
      /\$ per Mtok/.test(await page.getAttribute("#job-model", "title")) && /Artificial Analysis/.test(await page.getAttribute("#job-model", "title")),
      await page.getAttribute("#job-model", "title"),
    );
    check("no page errors so far", pageErrors, []);

    console.log("\n== the Settings control exists, and one press refills the menu ==");
    await page.click("#btn-settings");
    ok("the settings panel opens on the Model prices row", await page.isVisible("#models-row"), "");
    await waitFor(async () => /priced/.test((await page.textContent("#models-preview")) || ""), { what: "the preview to read back the cache" });
    const preview = await page.textContent("#models-preview");
    ok("which reads back what the menu is showing", /priced/.test(preview || ""), preview);
    ok("and the cache's own age", /old|never built/.test(await page.textContent("#models-age")), await page.textContent("#models-age"));

    const callsBefore = gateway.calls.length;
    await page.click("#btn-models-refresh");
    const refilled = await waitFor(async () => /5\.5/.test((await textFor("acme/priced-rated")) || ""), { what: "the menu to be refilled from the regenerated answer" });
    ok("the press refilled the dropdown from the newly regenerated answer", refilled, await textFor("acme/priced-rated"));
    check("and went to the gateway exactly once, for a regeneration", gateway.calls.length - callsBefore, 1);
    check("which asked for it", gateway.calls.at(-1).refresh, true);
    ok("the model the new answer dropped is gone from the menu", (await textFor("acme/new-model")) === null, JSON.stringify((await options()).map((o) => o.value)));
    ok("and a row the new answer started pricing gained its columns", /in \/ \$0\.75 out/.test((await textFor("acme/unpriced")) || ""), await textFor("acme/unpriced"));
    await waitFor(async () => /regenerated/.test((await page.textContent("#banner")) || ""), { what: "the banner's report" });
    const banner = await page.textContent("#banner");
    ok("the banner reports the before/after row counts", /→/.test(banner || "") && /rows/.test(banner || ""), banner);
    check("still no page errors", pageErrors, []);
    return { banner, preview };
  } finally {
    await context.close();
    await browser.close();
  }
}

// ---- run -------------------------------------------------------------------------------------
let shots = null;
try {
  await unitPhase();

  await startGateway(home);
  // The file the menu lists from, as a previous `hermes model` left it: one provider the stand-in gateway
  // prices, and one it prices nothing for.
  writeFileSync(
    modelsCacheFile,
    JSON.stringify({
      openrouter: { fp: "sandbox-fp", at: Date.now() / 1000 - 3600, models: MODELS_A },
      copilot: { fp: "sandbox-fp", at: Date.now() / 1000 - 3600, models: ["copilot/one", "copilot/two"] },
    }),
    "utf8",
  );
  writeConfig(await freePort(), gateway.url);
  const port = readJson(path.join(configDir, "config.json")).port;
  base = `http://127.0.0.1:${port}`;
  await startPanel(path.join(configDir, "config.json"));

  await warmPhase();
  await refreshPhase();

  console.log("\n== the browser: the columns, and the press ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-model-prices.mjs");
    failures += 1;
  } else {
    shots = await browserPhase(pw);
    if (shots?.banner) note(`banner: ${shots.banner}`);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: the formatter against the gateway's own strings (including the router sentinels), a real");
  console.log("sandbox panel over a stand-in gateway (a read path that issues no gateway call of its own and answers from");
  console.log("its cache file alone, the one-shot background warm, POST /api/models/refresh with both files' row counts");
  console.log("and mtimes before and after, the delete proved by a hand-planted row that does not survive), and headless");
  console.log("Chromium over that panel (the option text, the absent sentinel, the preview, the press and the refill).");
  console.log("WHAT WAS INSPECTED, NOT DRIVEN: that public/** is served from disk per request, so the page's half rides");
  console.log("a plain reload — read off server.js, not measured here.");
  if (!failures) console.log("MODEL-PRICES-VERIFY-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-25).join("\n")}`);
} finally {
  if (process.env.VERIFY_KEEP === "1") {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  } else {
    await stopPanel();
    await stopGateway();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
    }
  }
}
process.exitCode = failures ? 1 : 0;
