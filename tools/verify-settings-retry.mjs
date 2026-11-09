#!/usr/bin/env node
// The end-to-end half of "a settings write survives a slow panel": a real page, a real panel, and a proxy that makes
// the panel too slow to answer the chart-column PATCH twice in a row.
//
// The unit test (test/chart-columns.test.js) drives the retry seam with a fake clock. This tool proves the same
// behaviour with nothing faked inside the page: it boots the panel from THIS checkout against a throwaway config,
// puts a proxy in front of it that holds the first attempts of POST /api/settings/columns past the page's 8 s attempt
// deadline and answers them only after the page has given up, and then serves the next attempt at once. A browser
// opening the proxy's URL clicks one chart-column switch; the tool reports what config.json holds and the timeline
// of every attempt.
//
//   node tools/verify-settings-retry.mjs [--column life] [--hold-attempts 2] [--hold-ms 9500] [--timeout-ms 120000]
//                                        [--port <proxy port>] [--panel-port <panel port>] [--json]
//                                        [--ready <file>] [--out <file>]
//
// It prints one JSON line beginning with "VERIFY " when the proxy is listening, and the same payload goes to the
// --ready file; the verdict goes to stdout and to the --out file. Those two files are what a browser session (or a
// test) reads: stdout on Windows is a pipe, and a background run can lose what is still buffered at exit.
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { freePort, startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const COLUMN = String(arg("column", "life"));
const HOLD_ATTEMPTS = Math.max(0, Number(arg("hold-attempts", 2)) || 0);
const HOLD_MS = Math.max(1000, Number(arg("hold-ms", 9500)) || 9500);
const TIMEOUT_MS = Math.max(10_000, Number(arg("timeout-ms", 120_000)) || 120_000);
const JSON_OUT = process.argv.includes("--json");
// A background run's stdout on Windows is a pipe, and Node can drop what is still buffered when process.exit() is
// called. The two files are the reliable channel a caller reads: `--ready` appears when the proxy is listening,
// `--out` when the verdict is in.
const READY_FILE = arg("ready", null);
const OUT_FILE = arg("out", null);
const emit = (file, text) => {
  if (!file) return;
  try {
    writeFileSync(file, text, "utf8");
  } catch {
    /* a caller that cannot read the file still has stdout */
  }
};
const t0 = Date.now();
const at = () => Math.round(Date.now() - t0);

const panelPort = Number(arg("panel-port", 0)) || (await freePort());
const proxyPort = Number(arg("proxy-port", 0)) || (await freePort());

const panel = await startPanel({
  root: ROOT,
  port: panelPort,
  config: {
    // A panel with no projects: the switches are built from the chart's own column list, so an empty board still
    // draws every one of them, and nothing here can reach the reader's own state.
    scanRoots: [],
    hiddenColumns: [],
    fetchSeconds: 86_400,
    refreshSeconds: 3600,
    prCacheSeconds: 86_400,
    remoteCacheSeconds: 86_400,
  },
});
const configPath = panel.configPath;
const storedNow = () => {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")).hiddenColumns || [];
  } catch {
    return [];
  }
};
const start = storedNow();
const want = [...new Set([...start, COLUMN])].sort();

// ---- the proxy: a panel too busy to answer ---------------------------------------------------------------
const timeline = [];
let attempts = 0;
const proxy = createServer((req, res) => {
  const isColumnPost = req.method === "POST" && req.url.split("?")[0] === "/api/settings/columns";
  if (!isColumnPost) {
    const upstream = httpRequest(
      { host: "127.0.0.1", port: panelPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${panelPort}` } },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "proxy could not reach the panel" }));
    });
    req.pipe(upstream);
    return;
  }
  // The body is read whole before the hold: the page's write is small and this keeps the forwarded request intact.
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    attempts += 1;
    const n = attempts;
    const record = { attempt: n, sentAt: at(), held: n <= HOLD_ATTEMPTS, forwarded: false, answeredAt: null, status: null, clientGone: false };
    timeline.push(record);
    req.on("close", () => {
      if (!res.writableEnded) record.clientGone = true;
    });
    const send = () => {
      record.answeredAt = at();
      if (record.held) {
        // Held past the page's own attempt deadline and never processed: the request sat in the queue of a panel
        // that was busy with something else. A 504 is the honest answer, and the page has usually stopped listening.
        record.status = 504;
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(504, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "the panel is busy and did not process this write" }));
        }
        return;
      }
      if (res.writableEnded || res.destroyed) return;
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: panelPort,
          path: req.url,
          method: "POST",
          headers: { ...req.headers, host: `127.0.0.1:${panelPort}`, "content-length": String(body.length) },
        },
        (up) => {
          record.forwarded = true;
          record.status = up.statusCode || null;
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "proxy could not reach the panel" }));
      });
      upstream.end(body);
    };
    if (record.held) setTimeout(send, HOLD_MS);
    else send();
  });
});
await new Promise((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${proxyPort}`;
const ready = { base, panel: panel.base, configPath, column: COLUMN, start, want, holdAttempts: HOLD_ATTEMPTS, holdMs: HOLD_MS };
emit(READY_FILE, JSON.stringify(ready));
console.log(`VERIFY ${JSON.stringify(ready)}`);

// ---- wait for the write to land in config.json -----------------------------------------------------------
const deadline = Date.now() + TIMEOUT_MS;
let result = null;
for (;;) {
  const now = storedNow();
  if (now.includes(COLUMN)) {
    result = { stored: true, at: at(), hiddenColumns: now };
    break;
  }
  if (Date.now() > deadline) {
    result = { stored: false, at: at(), hiddenColumns: now };
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}

// The file the panel actually wrote, read BEFORE the panel is stopped (its sandbox is removed on stop). The page's
// answer is one thing; the bytes on disk are the proof the switch will read after the next boot, so the report
// carries them rather than a path that no longer exists when the reader opens it.
const configFile = (() => {
  try {
    return { path: configPath, text: readFileSync(configPath, "utf8"), mtimeMs: statSync(configPath).mtimeMs };
  } catch {
    return { path: configPath, text: null, mtimeMs: null };
  }
})();
const firstAttemptAt = timeline[0] ? timeline[0].sentAt : null;
const forwardedAt = (timeline.find((t) => t.forwarded) || {}).sentAt ?? null;
const gaps = [];
for (let i = 1; i < timeline.length; i += 1) gaps.push(timeline[i].sentAt - timeline[i - 1].sentAt);

const report = {
  ok: result.stored,
  column: COLUMN,
  expected: want,
  hiddenColumns: result.hiddenColumns,
  storedAtMs: result.stored ? result.at : null,
  configPath,
  configFile,
  firstAttemptAtMs: firstAttemptAt,
  forwardedAtMs: forwardedAt,
  attemptGapsMs: gaps,
  landedAfterFirstAttemptMs: result.stored && firstAttemptAt !== null ? result.at - firstAttemptAt : null,
  timeline,
  attempts: attempts,
  heldAttempts: timeline.filter((t) => t.held).length,
};
const text = JSON.stringify(report, null, 2);
emit(OUT_FILE, text);
if (JSON_OUT) console.log(text);
else console.log(`VERIFY-DONE ${JSON.stringify(report)}`);
proxy.close();
await panel.stop();
process.exitCode = report.ok ? 0 : 1;
