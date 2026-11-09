#!/usr/bin/env node
// HARNESS: LIVE GATE
// The job store is read by a running panel and by the next boot, so a write must never be visible half done.
//
// WHAT WAS SEEN. jobs.json sat at exactly 1,048,576 bytes with its JSON cut mid-string, then at 0 bytes, then
// at 524,288 bytes, all inside one minute. A plain writeFile truncates the target and fills it, so every one of
// those states was readable by anything that asked: a reader got a fragment, and a restart landing in that
// window logged "could not read" and lost every job.
//
// WHAT THIS PROVES. Two processes, not one: a READER that does nothing but readFileSync + JSON.parse in a tight
// loop, and this process writing a full-size store over and over through the panel's own writer. The reader
// records, for every single read, the byte length and whether it parsed. With the temp-file-and-rename writer
// only two lengths may EVER be observed - the whole old snapshot and the whole new one - so any third length is
// a fragment that reached a reader, and any parse failure is a torn JSON document.
//
//   node tools/verify-store-atomic.mjs            the gate: every read whole, 0 failures, 300+ reads per second
//   node tools/verify-store-atomic.mjs --legacy   the CONTROL: the same loop against plain writeFile, the writer
//                                                 this replaced. It is evidence, not a gate: it reports how many
//                                                 fragments the loop catches, so a green run above is known to be
//                                                 the verdict of a loop that actually looks.
//   --ms <n>                                      how long the reader reads and the writer writes (default 5000)
//
// The reader is a CHILD process on the same file, which is the shape of the failure: the second process is the
// restart, the reload, the tool that reads the store while the panel is mid-write.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileQueued } from "../lib/jobs.js";

const SELF = fileURLToPath(import.meta.url);
const READER = "--reader";

// A store-shaped snapshot: one entry per conversation, each with the console lines the panel persists, sized so
// the payload is a real store rather than a fixture a write cannot be caught inside.
function storePayload({ jobs, savedAt, lines = 60, line = 220 }) {
  const filler = "x".repeat(line);
  return JSON.stringify({
    savedAt,
    jobs: Array.from({ length: jobs }, (_, i) => ({
      id: `j-${i}`,
      thread: `t-${i}`,
      status: "done",
      startedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 60_000).toISOString(),
      lines: Array.from({ length: lines }, (_, n) => ({ lid: n + 1, text: `${i}/${n} ${filler}` })),
    })),
  });
}

const bytesOf = (text) => Buffer.byteLength(text, "utf8");
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// THE READER, run as its own process so nothing it does can be starved by the writer's event loop.
function readerMain(argv) {
  const [file, expectedCsv, msArg] = argv;
  const expected = new Set(expectedCsv.split(",").map(Number));
  const runMs = Math.max(200, Number(msArg) || 5000);

  let reads = 0;
  let parsed = 0;
  let parseErrors = 0;
  let readErrors = 0;
  let fragmentSizes = 0;
  let emptyReads = 0;
  let minBytes = Number.POSITIVE_INFINITY;
  let maxBytes = 0;
  const sizes = new Map();

  process.stdout.write("READY\n");
  const started = process.hrtime.bigint();
  const until = Date.now() + runMs;
  while (Date.now() < until) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      readErrors += 1;
      continue;
    }
    reads += 1;
    const bytes = bytesOf(text);
    if (bytes < minBytes) minBytes = bytes;
    if (bytes > maxBytes) maxBytes = bytes;
    if (bytes === 0) emptyReads += 1;
    if (!expected.has(bytes)) fragmentSizes += 1;
    // Cap the histogram: a broken writer produces a new length almost every read, and the count is the point.
    const seen = sizes.get(bytes) || 0;
    if (seen || sizes.size < 24) sizes.set(bytes, seen + 1);
    try {
      JSON.parse(text);
      parsed += 1;
    } catch {
      parseErrors += 1;
    }
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const summary = {
    reads,
    parsed,
    parseErrors,
    readErrors,
    fragmentSizes,
    emptyReads,
    minBytes: Number.isFinite(minBytes) ? minBytes : 0,
    maxBytes,
    seconds,
    perSecond: Math.round(reads / seconds),
    expectedBytes: [...expected],
    sizes: [...sizes.entries()].sort((a, b) => b[0] - a[0]),
  };
  process.stdout.write(`SUMMARY ${JSON.stringify(summary)}\n`);
}

function startReader(file, expectedBytes, ms) {
  const child = spawn(process.execPath, [SELF, READER, file, expectedBytes.join(","), String(ms)], {
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  let out = "";
  let summary = null;
  const takeSummary = () => {
    const line = out.split(/\r?\n/).find((l) => l.startsWith("SUMMARY "));
    if (!line || summary) return;
    try {
      summary = JSON.parse(line.slice("SUMMARY ".length));
    } catch {
      /* reported as a missing summary below */
    }
  };
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      takeSummary();
      if (out.includes("READY")) resolve();
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  const done = new Promise((resolve) => {
    child.on("exit", () => {
      takeSummary();
      resolve(summary);
    });
  });
  return { ready, done };
}

function argOf(argv, name, fallback) {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : Number(argv[at + 1]) || fallback;
}

async function main(argv) {
  const legacy = argv.includes("--legacy");
  const runMs = argOf(argv, "--ms", 5000);
  const writeBudgetMs = Math.max(200, runMs - 150);

  const dir = mkdtempSync(path.join(tmpdir(), "wag-store-atomic-"));
  const file = path.join(dir, "jobs.json");
  const name = path.basename(file);
  try {
    // Two whole snapshots of different lengths, so the reader can tell a torn read from an equal-length one and
    // both states are real stores rather than one padded fixture. Both are above the 1 MiB the live store reached.
    const older = storePayload({ jobs: 72, savedAt: "older" });
    const newer = storePayload({ jobs: 80, savedAt: "newer" });
    const olderJobs = JSON.parse(older).jobs.length;
    const newerJobs = JSON.parse(newer).jobs.length;
    const olderBytes = bytesOf(older);
    const newerBytes = bytesOf(newer);
    const full = Math.max(olderBytes, newerBytes);
    const smallest = Math.min(olderBytes, newerBytes);

    console.log("store-atomic: a reader against a live store");
    console.log(
      `  writer:    ${legacy ? "plain writeFile (the writer this replaced) - CONTROL" : "writeFileQueued - temp file, fsync, rename"}`,
    );
    console.log(`  payloads:  ${commas(newerBytes)} bytes (${newerJobs} jobs) and ${commas(olderBytes)} bytes (${olderJobs} jobs)`);
    if (!legacy && smallest < 1_048_576) {
      console.log(`  NOTE:      the smaller payload is ${commas(smallest)} bytes, under the 1 MiB the real store reached`);
    }

    // Seed a whole store first, through the writer under test, so the reader never starts on a missing file.
    await writeFileQueued(file, older);
    if (readFileSync(file, "utf8") !== older) throw new Error("the seeded store does not read back as the payload written");

    const reader = startReader(file, [olderBytes, newerBytes], runMs);
    await reader.ready;

    const writeUntil = Date.now() + writeBudgetMs;
    let writes = 0;
    let writeErrors = 0;
    let next = newer;
    while (Date.now() < writeUntil) {
      // The atomic writer gets a burst per round: the chain serializes them, which is the concurrency the panel
      // itself produces when a tick and a settle land in the same 700 ms window.
      const results = legacy
        ? [writeFile(file, next)]
        : [writeFileQueued(file, next), writeFileQueued(file, next === newer ? older : newer), writeFileQueued(file, next)];
      const settled = await Promise.allSettled(results);
      writes += settled.filter((s) => s.status === "fulfilled").length;
      writeErrors += settled.filter((s) => s.status === "rejected").length;
      next = next === newer ? older : newer;
    }
    const summary = await reader.done;
    if (!summary) throw new Error("the reader process printed no summary");

    const leftovers = readdirSync(dir).filter((n) => n !== name);
    const tempLeft = leftovers.filter((n) => /\.tmp$/.test(n));
    const observedList = summary.sizes.map(([b, n]) => `${commas(b)} x${n}`).join(", ");

    console.log(`  reader:    ${commas(summary.reads)} reads in ${summary.seconds.toFixed(2)} s (${commas(summary.perSecond)}/s)`);
    console.log(
      `  parse:     ${commas(summary.parsed)} parsed, ${commas(summary.parseErrors)} failures, ${commas(summary.readErrors)} read errors`,
    );
    console.log(`  sizes:     ${observedList || "none"}`);
    console.log(`             smallest ${commas(summary.minBytes)} bytes, largest ${commas(summary.maxBytes)} bytes`);
    console.log(`  writes:    ${commas(writes)} snapshots landed, ${commas(writeErrors)} failed`);
    console.log(`  temp:      ${tempLeft.length ? `${tempLeft.length} temp file(s) left beside the store` : "none left beside the store"}`);

    if (legacy) {
      console.log("");
      console.log(
        summary.fragmentSizes || summary.parseErrors || summary.emptyReads
          ? `CONTROL: ${commas(summary.fragmentSizes)} of ${commas(summary.reads)} reads were a length no whole store has, and ${commas(summary.parseErrors)} did not parse. That is the window.`
          : `CONTROL: the loop saw no fragment this time (${commas(summary.reads)} reads) - the write window was not hit, so read this run as inconclusive rather than as a clean writer.`,
      );
      console.log("RESULT: CONTROL - plain writeFile is not gated here; the numbers above are the evidence that the loop looks.");
      return 0;
    }

    const failures = [];
    if (summary.reads < 200) failures.push(`only ${summary.reads} reads landed; the loop has to run long enough to matter`);
    if (summary.perSecond < 300) failures.push(`${summary.perSecond} reads per second is under the several hundred a second this asks for`);
    if (summary.parseErrors > 0) failures.push(`${summary.parseErrors} reads did not parse as JSON`);
    if (summary.readErrors > 0) failures.push(`${summary.readErrors} reads threw instead of returning the store`);
    if (summary.emptyReads > 0) failures.push(`${summary.emptyReads} reads returned 0 bytes`);
    if (summary.fragmentSizes > 0) failures.push(`${summary.fragmentSizes} reads returned a length no whole store has`);
    if (summary.maxBytes !== full) failures.push(`the largest file observed was ${summary.maxBytes} bytes, not the ${full} it should be`);
    if (summary.minBytes !== smallest) {
      failures.push(`the smallest file observed was ${summary.minBytes} bytes, not the ${smallest} of the smaller whole snapshot`);
    }
    if (writes < 20) failures.push(`only ${writes} writes landed; written repeatedly needs more`);
    if (writeErrors > 0) failures.push(`${writeErrors} writes failed`);
    if (tempLeft.length > 0) failures.push(`${tempLeft.length} temp file(s) left beside the store`);
    const finalDoc = JSON.parse(readFileSync(file, "utf8"));
    if (finalDoc.jobs.length !== olderJobs && finalDoc.jobs.length !== newerJobs) failures.push("the file left on disk is not one of the two whole snapshots");

    console.log("");
    if (failures.length) {
      for (const f of failures) console.log(`FAIL  ${f}`);
      console.log(`RESULT: FAIL - ${failures.length} check(s)`);
      return 1;
    }
    console.log(
      `RESULT: PASS - ${commas(summary.reads)} reads at ${commas(summary.perSecond)} per second, every one a whole store; ` +
        `largest file observed ${commas(summary.maxBytes)} bytes, the size it should be; 0 fragments, 0 parse failures`,
    );
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[2] === READER) {
  readerMain(process.argv.slice(3));
} else {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.log(`RESULT: FAIL - ${String((err && err.message) || err)}`);
      process.exitCode = 1;
    });
}
