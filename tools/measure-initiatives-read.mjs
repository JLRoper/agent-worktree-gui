#!/usr/bin/env node
// TIME EACH SEAM OF THE INITIATIVES TAB'S TWO READS, on a copy of the state, cold and warm.
//
// HARNESS: MEASUREMENT (not a gate).
//
//   node tools/measure-initiatives-read.mjs --from-live --state <scratch>/init-read
//   node tools/measure-initiatives-read.mjs --root <scratch>/base --state <scratch>/init-read-base --from-live
//   node tools/measure-initiatives-read.mjs --diff <scratch>/before.json <scratch>/after.json
//
// WHAT IT DOES. It copies the panel's own state (initiatives, waves, the assistants' queues, the discovery cache and
// the hosts map) into `--state`, writes a config that points the scan at the same roots but stops the timers
// (refreshSeconds, fetchSeconds and the read cadences are all an hour), boots the REAL `server.js` of `--root` with
// `PANEL_CONFIG`, waits for the boot pass and for the board's row enrichment to stop changing, and then times:
//
//   GET /api/initiatives              cold (the first read in the process) and warm
//   GET /api/waves?initiative=<id>    for the lanes the state carries, first read each
//
// `?profile=1` rides on the cold reads, so the answer carries the phase clock (lib/read-profile.js): the queue fold,
// the gate paths, the evidence read and its halves (member.pr, member.landing, member.files), the lane fold, the
// template lookup, plus the operations that were performed (git.calls, pr.host.calls, pr.read, evidence.members) and
// the hosts that were asked. A seam that reaches the network names its host there.
//
// `--save <file>` writes every body it captured (initiatives plus each lane) so `--diff` can compare two runs: the
// payload a change must keep is the payload these bodies carry, and --diff normalises only the two fields that name
// the read itself (`at`) and the sandbox (`file`).
//
// The state it boots is a COPY. Nothing here writes the reader's board, and no worktree is cut: an export from
// `git archive <base> | tar -x -C <dir>` is the before arm.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startPanel } from "./panel-testkit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback = "") => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const has = (name) => args.includes(name);

// The state files the two reads are built from. A file the live panel does not have is simply not copied: a board with
// no waves file is the ordinary first run, and the lane then answers an empty list.
const STATE_FILES = ["initiatives.json", "waves.json", "assistants.json", "hosts.json", "pipeline-bundle.json", "projects.json", "tree-cache.json"];
const ASSISTANT_QUEUES = ["assistant-1", "assistant-2", "assistant-3", "assistant-5"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function diffMode(beforeFile, afterFile) {
  const before = JSON.parse(readFileSync(beforeFile, "utf8"));
  const after = JSON.parse(readFileSync(afterFile, "utf8"));
  // `at` is the read's own clock and `file` names the sandbox it read; every other field is the payload.
  const strip = (value, where) => {
    if (Array.isArray(value)) return value.map((entry) => strip(entry, where));
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (where === "" && (key === "at" || key === "file")) continue;
      out[key] = strip(entry, `${where}/${key}`);
    }
    return out;
  };
  const walk = (a, b, where, out) => {
    if (out.length > 200) return out;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${where || "/"}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      return out;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
      out.push(`${where || "/"}: ${Array.isArray(a) ? "list" : "object"} -> ${Array.isArray(b) ? "list" : "object"}`);
      return out;
    }
    const keys = Array.isArray(a) ? [...new Set([...a.keys(), ...b.keys()])] : [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      const next = Array.isArray(a) ? `${where}[${key}]` : `${where}/${key}`;
      if (Array.isArray(a) && (Number(key) >= a.length || Number(key) >= b.length)) {
        out.push(`${next}: list length ${a.length} -> ${b.length}`);
        continue;
      }
      if (!(key in a) || !(key in b)) {
        out.push(`${next}: ${key in a ? "removed" : "added"}`);
        continue;
      }
      walk(a[key], b[key], next, out);
    }
    return out;
  };
  let total = 0;
  for (const key of Object.keys(before.bodies || {})) {
    const one = strip(JSON.parse(before.bodies[key]), "");
    const two = strip(JSON.parse((after.bodies || {})[key] || "{}"), "");
    const diffs = walk(one, two, "", []);
    total += diffs.length;
    console.log(`${key}: ${diffs.length ? `${diffs.length} difference(s)` : "identical"}`);
    for (const line of diffs.slice(0, 12)) console.log(`  ${line}`);
  }
  console.log(total ? `PAYLOAD CHANGED: ${total} difference(s)` : "PAYLOAD IDENTICAL (at and file normalised)");
  process.exitCode = total ? 1 : 0;
}

async function main() {
  if (has("--diff")) {
    diffMode(args[args.indexOf("--diff") + 1], args[args.indexOf("--diff") + 2]);
    return;
  }
  const root = path.resolve(arg("--root", ROOT));
  const state = path.resolve(arg("--state", path.join(os.tmpdir(), "wag", "measure-initiatives-read")));
  const configPath = path.resolve(arg("--config", path.join(ROOT, "config.json")));
  const order = arg("--order", "initiatives");
  const save = arg("--save", "");
  const roots = arg("--roots", "");
  const liveState = path.resolve(arg("--live-state", path.join(os.homedir(), ".wag", "state")));

  const stateDir = path.join(state, "state");
  mkdirSync(path.join(stateDir, "assistants"), { recursive: true });
  if (has("--from-live")) {
    for (const name of STATE_FILES) {
      const from = path.join(liveState, name);
      if (existsSync(from)) cpSync(from, path.join(stateDir, name));
    }
    for (const who of ASSISTANT_QUEUES) {
      const from = path.join(liveState, "assistants", who, "queue.json");
      if (!existsSync(from)) continue;
      mkdirSync(path.join(stateDir, "assistants", who), { recursive: true });
      cpSync(from, path.join(stateDir, "assistants", who, "queue.json"));
    }
  }

  const live = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const config = {
    ...live,
    // The scan reads the same roots, but nothing re-reads them while the measurement runs: a timer firing mid-read is
    // load, and this harness is measuring the read.
    refreshSeconds: 3600,
    fetchSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    dataDir: state,
    jobsFile: path.join(stateDir, "jobs.json"),
    assistantFile: path.join(stateDir, "assistant.json"),
    projectsCacheFile: path.join(stateDir, "projects.json"),
    matrix: { ...(live.matrix || {}), autoStart: false },
  };
  // A narrower fleet is a smaller, faster, IDENTICAL board for both arms of a payload diff (see --diff).
  if (roots) config.scanRoots = roots.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean);
  delete config.port;
  delete config.host;

  const panel = await startPanel({ dir: state, keep: true, root, config });
  const bodies = {};
  const rows = [];

  const get = async (url) => {
    const t0 = performance.now();
    const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    const text = await r.text();
    return { status: r.status, ms: Math.round(performance.now() - t0), bytes: text.length, text };
  };

  try {
    // READY. The full snapshot carries a `counts` block; the board frame does not.
    for (let i = 0; i < 600; i += 1) {
      const r = await get(`${panel.base}/api/state`);
      try {
        if (JSON.parse(r.text).counts) break;
      } catch {
        /* still booting */
      }
      await sleep(500);
    }
    // SETTLED. The scan enriches each row after the boot pass (verdict, dirty, ahead, pr) and a background fetch pass
    // rewrites every row's branch verdict when it lands. A body captured mid-way differs from the same read taken
    // later for reasons that are the scan's, not the read's, so wait for the fetch pass (started right after boot) to
    // have landed and for the row signature to stop moving.
    await sleep(roots ? 15_000 : 90_000);
    let previous = "";
    let stable = 0;
    for (let i = 0; i < 200 && stable < 3; i += 1) {
      const r = await get(`${panel.base}/api/board`);
      let signature = `unreadable:${i}`;
      try {
        const board = JSON.parse(r.text);
        // Rows live under each project's `worktrees` (the board frame is the store's snapshot, not the full document).
        const list = Array.isArray(board.rows)
          ? board.rows
          : (Array.isArray(board.projects) ? board.projects : []).flatMap((project) => (Array.isArray(project.worktrees) ? project.worktrees : []));
        signature = `${list.length}:${list.filter((row) => row && row.verdict != null && row.verdict !== "…").length}`;
      } catch {
        /* board not there yet */
      }
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable < 3) await sleep(3000);
    }
    await sleep(roots ? 5_000 : 15_000);
    console.log(`panel ${panel.base} root ${root}`);
    console.log(`board settled at ${previous}`);

    const lanes = (() => {
      try {
        const store = JSON.parse(readFileSync(path.join(stateDir, "waves.json"), "utf8"));
        return Object.keys(store.byInitiative || {});
      } catch {
        return [];
      }
    })();
    const gated = lanes.slice(0, 4);
    const state_ = await get(`${panel.base}/api/state`);
    rows.push({ label: "GET /api/state", ...state_ });
    const note = (r, label) => {
      const row = { label, status: r.status, ms: r.ms, bytes: r.bytes };
      try {
        const body = JSON.parse(r.text);
        if (body.profile) row.profile = body.profile;
      } catch {
        /* not a document */
      }
      rows.push(row);
    };

    if (order === "waves") {
      for (const id of gated.slice(0, 1)) {
        const r = await get(`${panel.base}/api/waves?initiative=${id}&profile=1`);
        note(r, `GET /api/waves?initiative=${id} (cold, first read)`);
        bodies[`waves:${id}`] = r.text;
      }
    }
    const cold = await get(`${panel.base}/api/initiatives?profile=1`);
    note(cold, "GET /api/initiatives (cold)");
    bodies.initiatives = cold.text;
    const warm = await get(`${panel.base}/api/initiatives`);
    note(warm, "GET /api/initiatives (warm)");
    for (const id of gated) {
      if (bodies[`waves:${id}`]) continue;
      const r = await get(`${panel.base}/api/waves?initiative=${id}&profile=1`);
      note(r, `GET /api/waves?initiative=${id}`);
      bodies[`waves:${id}`] = r.text;
    }

    console.log("");
    for (const row of rows) {
      console.log(`${String(row.ms).padStart(7)} ms  ${String(row.bytes).padStart(8)} B  ${row.status}  ${row.label}`);
      if (row.profile) {
        console.log(`         phases ${JSON.stringify(row.profile.phases)}`);
        console.log(`         ops    ${JSON.stringify(row.profile.operations)}  facts ${JSON.stringify(row.profile.facts)}`);
      }
    }
    if (save) {
      mkdirSync(path.dirname(path.resolve(save)), { recursive: true });
      writeFileSync(path.resolve(save), JSON.stringify({ rows, bodies }, null, 1));
      console.log(`\nbodies written to ${path.resolve(save)}`);
    }
  } finally {
    await panel.stop();
    console.log(`\nsandbox kept at ${state}`);
  }
}

await main();
