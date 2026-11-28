// Settings → General's "Storage & cleanup" section: a list of the three disposable targets, a read-only process
// census, and two presses per row (Preview, Clean).
//
// The section is the page's own code, so this slices the region out of public/app.js and drives it against a DOM stub
// the way settings-pipeline-tab-pdl.test.js drives the Pipeline tab. Five facts:
//
//   1. the markup mounts in the General panel, carries a Refresh sizes press, and carries NO terminate control — the
//      census is read only;
//   2. a GET renders each target with its label, size and file count, and the census names sandbox panels (with the
//      oldest age), test runners and orphan panels;
//   3. Preview posts `dryRun: true`, and Clean posts `dryRun: false`;
//   4. a bounded clean says how many entries remain, and a refusal is shown as the reason the server gave;
//   5. a failed GET is a notice at the top of the section while the last good list stays, and missing fields render
//      as "unknown" rather than throwing over the rest of the General tab.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sliceRegion } from "../tools/panel-testkit.mjs";
import { readStyleSheets } from "./style-sheets.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readStyleSheets().replace(/\/\*[\s\S]*?\*\//g, "");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const region = sliceRegion(app, "settings > storage & cleanup");

const generalStart = html.indexOf('data-settings-group="general"');
const generalEnd = html.indexOf('<div class="settings-group', generalStart + 10);
const general = html.slice(generalStart, generalEnd > 0 ? generalEnd : undefined);

class El {
  constructor(id) {
    this.id = id;
    this._text = "";
    this._html = "";
    this.value = "";
    this.listeners = {};
    this._classes = new Set();
    this.classList = {
      contains: (name) => this._classes.has(name),
      add: (name) => this._classes.add(name),
      remove: (name) => this._classes.delete(name),
      toggle: (name, on) => {
        const want = on === undefined ? !this._classes.has(name) : Boolean(on);
        if (want) this._classes.add(name);
        else this._classes.delete(name);
      },
    };
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
}

function makePanel({ get, post } = {}) {
  const ids = [
    "maintenance-targets",
    "maintenance-processes",
    "maintenance-processes-summary",
    "maintenance-window-hermes-sessions",
    "btn-maintenance-refresh",
  ];
  const doc = {};
  for (const id of ids) doc[id] = new El(id);
  doc.getElementById = (id) => doc[id] || null;

  const calls = { gets: 0, posts: [], postOpts: [] };
  const apiFetch = async (url, opts = {}, extra = {}) => {
    if (url === "/api/maintenance" && (!opts.method || opts.method === "GET")) {
      calls.gets += 1;
      return get(calls.gets);
    }
    if (url === "/api/maintenance/clean" && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      calls.posts.push(body);
      calls.postOpts.push(extra);
      return post(body);
    }
    return { ok: false, status: 404, json: async () => ({ error: "no route in this stub" }) };
  };

  const api = new Function(
    "document",
    "apiFetch",
    "esc",
    `${region}
     return {
       loadMaintenance,
       paintMaintenance,
       runMaintenance,
       results: MAINTENANCE_RESULTS,
       get index() { return maintenanceIndex; },
       set index(v) { maintenanceIndex = v; },
     };`,
  )(doc, apiFetch, (s) => String(s ?? ""));

  return { doc, api, calls };
}

const until = async (what, fn, tries = 200) => {
  for (let i = 0; i < tries; i += 1) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const GET_ANSWER = {
  ok: true,
  targets: [
    { id: "scratch", label: "Scratch folder", detail: "the throwaway half", bytes: 12 * 1024 * 1024, files: 318, dirs: 4, removable: true },
    { id: "state-temp", label: "State temp", detail: "per-run files", bytes: 3 * 1024 * 1024, files: 2, dirs: 1, removable: true },
    { id: "log-archives", label: "Log archives", detail: "rotated logs", bytes: 512 * 1024, files: 1, dirs: 0, removable: false, blockedReason: "one archive is still open" },
  ],
  processes: {
    sandboxPanels: [
      { pid: 11, startedAt: "2026-11-28T06:00:00Z", ageSeconds: 3720, cpuSeconds: 4, parentAlive: true },
      { pid: 12, startedAt: "2026-11-28T06:10:00Z", ageSeconds: 600, cpuSeconds: 1, parentAlive: true },
    ],
    testRunners: [{ pid: 21 }],
    orphanPids: [],
  },
};

test("the section mounts in the General tab with a refresh press and no terminate control", () => {
  assert.match(html, /id="maintenance-targets"/, "the list is a mounted root");
  assert.match(html, /id="btn-maintenance-refresh"/, "Refresh sizes is present");
  assert.ok(general.includes('id="maintenance-targets"'), "the section is inside the General panel");
  assert.doesNotMatch(general, /terminate|kill/i, "the census carries no terminate button");
  assert.equal((html.match(/data-maintenance-target=/g) || []).length, 0, "rows are drawn, not static markup");
  assert.match(css, /\.maintenance-target \{/, "the stylesheet styles a target card");
  assert.match(css, /\.maintenance-processes \{/, "the census line has its own rule");
  // No emoji anywhere in the section: the house style says words.
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const at = html.indexOf('id="maintenance-targets-row"');
  const section = html.slice(at, html.indexOf('data-settings-group="prompt"', at));
  assert.doesNotMatch(section, emoji, "the markup carries no emoji");
});

test("a GET renders each target and the read-only census", async () => {
  const { doc, api } = makePanel({ get: async () => ({ ok: true, json: async () => GET_ANSWER }) });
  await api.loadMaintenance();
  const drawn = doc.getElementById("maintenance-targets").innerHTML;
  assert.match(drawn, /Scratch folder/, "the first target's label");
  assert.match(drawn, /12\.0 MB · 318 files/, "its size and file count");
  assert.match(drawn, /State temp/);
  assert.match(drawn, /Log archives/);
  assert.match(drawn, /one archive is still open/, "a blocked target's reason is shown");
  assert.match(drawn, /data-maintenance-clean="log-archives" title="[^"]+" disabled/, "a blocked target's Clean is disabled");
  const census = doc.getElementById("maintenance-processes").textContent;
  assert.match(census, /2 sandbox panels · oldest 1h 2m/);
  assert.match(census, /1 test runner/);
  assert.match(census, /0 orphan panels/);
  assert.equal(doc.getElementById("maintenance-processes-summary").textContent, "2 panels · 1 runner · 0 orphans", "the Processes heading carries the census, not the target count");
});

test("Preview posts a dry run and Clean posts the real one", async () => {
  let seen = 0;
  const { doc, api, calls } = makePanel({
    get: async () => ({ ok: true, json: async () => GET_ANSWER }),
    post: async (body) => {
      seen += 1;
      return {
        ok: true,
        json: async () => ({ ok: true, target: body.target, dryRun: body.dryRun, removedFiles: 40, removedBytes: 1024 * 1024, remaining: seen === 1 ? 3 : 0, ms: 12 }),
      };
    },
  });
  await api.loadMaintenance();
  await api.runMaintenance("scratch", true);
  assert.deepEqual(calls.posts[0], { target: "scratch", dryRun: true }, "Preview is the dry run");
  assert.match(api.results.get("scratch").text, /would remove 40 files · 1\.0 MB/);
  assert.match(api.results.get("scratch").text, /3 entries remain — run Clean again/, "a bounded dry run says what is left");

  await api.runMaintenance("scratch", false);
  assert.deepEqual(calls.posts[1], { target: "scratch", dryRun: false }, "Clean is the real run");
  assert.match(api.results.get("scratch").text, /removed 40 files · 1\.0 MB/);
  assert.doesNotMatch(api.results.get("scratch").text, /entries remain/, "nothing is left after the second press");
  await until("the post-clean re-read", () => calls.gets >= 2);
  assert.equal(doc.getElementById("maintenance-processes-summary").textContent, "2 panels · 1 runner · 0 orphans", "the list survived the re-read");
});

test("a refusal is shown as the reason the server gave, and a failed GET keeps the last list", async () => {
  let fail = false;
  const { doc, api, calls } = makePanel({
    get: async () =>
      fail
        ? { ok: false, status: 500, json: async () => ({ error: "walk failed" }) }
        : { ok: true, json: async () => GET_ANSWER },
    post: async (body) => ({ ok: true, json: async () => ({ ok: true, target: body.target, dryRun: body.dryRun, removedFiles: 0, removedBytes: 0, remaining: 5, refused: "a test runner holds this folder" }) }),
  });
  await api.loadMaintenance();
  await api.runMaintenance("state-temp", false);
  assert.match(api.results.get("state-temp").text, /refused: a test runner holds this folder/);
  assert.equal(api.results.get("state-temp").bad, true);
  // A real clean re-reads the sizes; let that read settle before the failure under test, or this press joins it.
  await until("the post-clean re-read", () => calls.gets >= 2);
  await new Promise((r) => setTimeout(r, 10));

  fail = true;
  await api.loadMaintenance();
  const drawn = doc.getElementById("maintenance-targets").innerHTML;
  assert.match(drawn, /could not answer for storage sizes — walk failed/, "the failure is a notice");
  assert.match(drawn, /Scratch folder/, "the last good rows stay under it");
  assert.match(drawn, /12\.0 MB · 318 files/, "sizes are not blanked by the failure");
});

test("missing fields render as unknown instead of throwing", async () => {
  const thin = { ok: true, targets: [{ id: "scratch", label: "Scratch folder" }, { id: "state-temp" }], processes: {} };
  const { doc, api } = makePanel({ get: async () => ({ ok: true, json: async () => thin }) });
  await api.loadMaintenance();
  const drawn = doc.getElementById("maintenance-targets").innerHTML;
  assert.match(drawn, /size unknown · file count unknown/, "an absent size reads unknown");
  assert.match(drawn, /state-temp/, "a target with no label falls back to its id");
  const census = doc.getElementById("maintenance-processes").textContent;
  assert.match(census, /sandbox panels unknown/, "an absent array is unknown, not zero");
  assert.match(census, /orphan panels unknown/);
});

test("the sessions card offers the unused-for window and the press carries it", async () => {
  const answer = {
    ok: true,
    targets: [{ id: "hermes-sessions", label: "Hermes sessions", detail: "the stores", bytes: 8 * 1024 ** 3, files: 4, removable: true }],
    processes: { sandboxPanels: [], testRunners: [], orphanPids: [] },
  };
  const { doc, api, calls } = makePanel({
    get: async () => ({ ok: true, json: async () => answer }),
    post: async (body) => ({
      ok: true,
      json: async () => ({ ok: true, target: body.target, dryRun: body.dryRun, removedFiles: 3, removedBytes: 0, remaining: 0 }),
    }),
  });

  await api.loadMaintenance();
  const html = doc.getElementById("maintenance-targets").innerHTML;
  assert.match(html, /id="maintenance-window-hermes-sessions"/, "the card carries the window control");
  assert.match(html, /<option value="24">/, "24 hours is offered");
  assert.match(html, /<option value="168">/, "a week is offered");
  assert.match(html, /<option value="720">/, "a month is offered");

  doc["maintenance-window-hermes-sessions"].value = "168";
  await api.runMaintenance("hermes-sessions", true);
  assert.deepEqual(calls.posts[0], { target: "hermes-sessions", dryRun: true, olderThanHours: 168 }, "the chosen window rides the press");
  assert.ok(Number(calls.postOpts[0] && calls.postOpts[0].timeoutMs) >= 300000, "a Hermes prune waits past its VACUUM, not 60 s");
});
