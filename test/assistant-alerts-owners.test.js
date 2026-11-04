// Alerts get an owner, the last panel-wide piece of the per-assistant split.
//
// Rules, pad, watches and the message board already belong to one assistant each. The alerts list did not: `fired()`
// stamped an alert's `assistantId` only for an extra assistant, so Assistant #1's alerts were indistinguishable from
// the legacy records that predate the split, and the Alerts tab, its counts and the spawn strip drew every assistant's
// alerts on every tab.
//
// What this file is the contract for:
//
//   · every alert is stamped with its owner AT FIRE TIME, Assistant #1's included — `fired()`, the spawn card, the
//     draft card and the command-audit card all name their assistant instead of relying on absence;
//   · a legacy record (written before the split, no stamp at all) is resolved at READ time from its thread, with #1
//     as the fallback, and the store is never rewritten — the legacy list stays exactly what it was;
//   · the Alerts tab, its two counts, the header badge and the spawn strip are filtered to the assistant the reader
//     picked, and "All assistants" (the default) hides nothing.
//
// The last section drives the shipped renderers out of public/assistant.js with `sliceBetween`, because "a #3 tab does
// not show #2's alert" is a claim about the HTML and not about the store.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT, threadFor } from "../lib/assistants.js";
import { sliceBetween } from "../tools/panel-testkit.mjs";

const T0 = 1_700_000_000_000;
const iso = (ms = 0) => new Date(T0 + ms).toISOString();
const THREE = [
  { id: "assistant-1", name: "Assistant #1", threadId: ASSISTANT_THREAD, rules: [] },
  { id: "assistant-2", name: "Assistant #2", threadId: threadFor("assistant-2"), rules: [] },
  { id: "assistant-3", name: "Assistant #3", threadId: threadFor("assistant-3"), rules: [] },
];

async function panel(t, { alerts = [], assistants = THREE } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-alerts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts, journal: [] }));
  if (assistants) await writeFile(path.join(dir, "assistants.json"), JSON.stringify({ version: 1, assistants }));
  const rows = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: {
      list: () => rows,
      get: (id) => rows.find((j) => j.id === id) || null,
      firstOfThread: (thread) => rows.find((j) => j.thread === thread) || null,
    },
    getProjects: () => [],
    onLog: () => {},
  });
  const stored = async () => JSON.parse(await readFile(assistantFile, "utf8"));
  return { assistant, assistantFile, rows, stored };
}

// A record as an older build wrote it: no `assistantId` anywhere.
const legacy = (over = {}) => ({
  id: "legacy",
  key: "leftover|legacy",
  rule: "leftover",
  severity: "warn",
  thread: null,
  turnId: null,
  title: "a legacy alert",
  detail: "",
  evidence: [],
  at: iso(0),
  status: "open",
  level: "alert",
  ...over,
});

test("every fired alert carries its owner at fire time — Assistant #1's included", async (t) => {
  const { assistant, stored } = await panel(t);

  const mine = assistant.fired("leftover", "worker-tree", { thread: "wtgui-worker-1", title: "a worker thread's leftover" });
  const twos = assistant.fired("leftover", "two-own-turn", { thread: assistant.threadOf("assistant-2"), title: "#2's own turn" });
  const threes = assistant.fired("leftover", "three-own-turn", { thread: assistant.threadOf("assistant-3"), title: "#3's own turn" });

  assert.equal(mine?.assistantId, PRIMARY_ASSISTANT, "#1's alert says whose it is instead of leaving it unowned");
  assert.equal(twos?.assistantId, "assistant-2");
  assert.equal(threes?.assistantId, "assistant-3");
  assert.ok("assistantId" in mine, "the field is PRESENT on #1's record, not inferred from its absence");

  assistant.writeNow(); // persist() is debounced; the file is what a restart would read, so ask for it now
  const onDisk = await stored();
  assert.deepEqual(
    onDisk.alerts.map((a) => a.assistantId),
    [PRIMARY_ASSISTANT, "assistant-2", "assistant-3"],
    "the stamp is written with the alert, not only added to the answer",
  );
});

test("the stamp is the OWNER, not the assistant the wake ladder routed to", async (t) => {
  const { assistant, rows } = await panel(t);
  // #2's own last turn failed, so the ladder hands its wake to #1. The alert is still about #2's work, and the tab
  // must file it under #2 — the same answer a legacy record gets from its thread.
  rows.push({ id: "run-2", thread: assistant.threadOf("assistant-2"), status: "failed", startedAt: iso(0), endedAt: iso(60_000), lines: [] });
  assert.equal(assistant.wakeTarget("assistant-2").who, PRIMARY_ASSISTANT, "the ladder routes around the failed assistant");
  const alert = assistant.fired("leftover", "two-failed", { thread: assistant.threadOf("assistant-2"), title: "#2's failed turn" });
  assert.equal(alert?.assistantId, "assistant-2", "but the alert stays #2's");
});

test("every alert path stamps its owner: the spawn card and the command-audit card", async (t) => {
  const { assistant } = await panel(t);
  const gap = assistant.reportCommandGap(
    { turn: "7", thread: assistant.threadOf("assistant-3"), parsed: 2, reported: {}, reportedAt: null },
    { kind: "SPAWN", missing: 1, parsed: 2, lines: ["SPAWN agent-worktree-gui"] },
  );
  assert.equal(gap.assistantId, "assistant-3", "a card the audit raises under a #3 turn is #3's");
  const card = assistant.addSpawnAlert(
    { target: "agent-worktree-gui", prompt: "write the notes", existing: false, todos: [] },
    { turn: { id: "turn-2", thread: assistant.threadOf("assistant-2") }, assistantId: "assistant-2" },
  );
  assert.equal(card.assistantId, "assistant-2", "the spawn card names the assistant that proposed it");
  assert.equal(card.spawn.assistantId, "assistant-2", "and the press path still reads its own stamp");

  const ones = assistant.addSpawnAlert({ target: "agent-worktree-gui", prompt: "one's ask", existing: false }, { assistantId: PRIMARY_ASSISTANT });
  assert.equal(ones.assistantId, PRIMARY_ASSISTANT, "#1's spawn card is stamped too — the strip filters on it");
  assert.ok(!("assistantId" in ones.spawn), "while the inner spawn record keeps the shape the press path reads");
});

test("a legacy alert resolves to its thread's owner at read time, and the store is never rewritten", async (t) => {
  const { assistant, stored } = await panel(t, {
    alerts: [
      legacy({ id: "l-worker", key: "leftover|worker", thread: "wtgui-worker-9", title: "LEGACY-WORKER" }),
      legacy({ id: "l-three", key: "leftover|three", thread: threadFor("assistant-3"), title: "LEGACY-BY-THREAD" }),
      legacy({
        id: "l-spawn",
        key: "spawn|x",
        rule: "spawn",
        thread: null,
        title: "LEGACY-SPAWN",
        spawn: { prompt: "an old card", assistantId: "assistant-2" },
      }),
    ],
  });

  const byId = Object.fromEntries(assistant.state().alerts.map((a) => [a.id, a.assistantId]));
  assert.equal(byId["l-three"], "assistant-3", "the thread is the owner a legacy record is resolved from");
  assert.equal(byId["l-worker"], PRIMARY_ASSISTANT, "#1 is the fallback, as every alert was #1's before the split");
  assert.equal(byId["l-spawn"], "assistant-2", "a spawn card has no thread, so its own ask is the next rung");

  const onDisk = await stored();
  assert.ok(onDisk.alerts.every((a) => !("assistantId" in a)), "the legacy list is the record of what was fired — a read is not a migration");
});

test("the spawn badge's numbers are per assistant, not one panel-wide total", async (t) => {
  const { assistant } = await panel(t, {
    alerts: [
      legacy({ id: "s2", key: "spawn|two", rule: "spawn", spawn: { prompt: "two's", assistantId: "assistant-2" }, spawnWatch: { dueAt: iso(60_000) } }),
      legacy({ id: "s3", key: "spawn|three", rule: "spawn", spawn: { prompt: "three's", assistantId: "assistant-3" } }),
      legacy({ id: "s1", key: "spawn|one", rule: "spawn", spawn: { prompt: "one's" } }),
    ],
  });
  const s = assistant.spawnCardState();
  assert.equal(s.open, 3, "the panel-wide count is unchanged");
  assert.equal(s.byAssistant["assistant-1"].open, 1, "the unowned card is #1's");
  assert.equal(s.byAssistant["assistant-2"].open, 1);
  assert.equal(s.byAssistant["assistant-3"].open, 1);
  assert.equal(s.byAssistant["assistant-2"].nextDueAt, Date.parse(iso(60_000)), "the soonest card per assistant travels with the count");
});

// ---- the page: the Alerts tab, its counts and the spawn strip --------------------------------

const page = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const REGION = sliceBetween(page, "// ---- what arrives from the server", "// ---- watches");
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const el = () => ({ innerHTML: "", textContent: "", hidden: false, title: "", className: "", dataset: {}, classList: { toggle() {} }, querySelectorAll: () => [] });
const sessionById = (id) => THREE.find((a) => a.id === String(id || "")) || null;
const assistantIds = () => THREE.map((a) => a.id);

function alertsPane({ alerts, who = "all", watches = [], serverCards = null }) {
  const hosts = new Map();
  for (const id of ["as-alerts", "assistant-badge", "btn-assistant", "assistant-spawn-badge", "spawn-strip"]) hosts.set(id, el());
  const state = {
    assistant: {
      alerts,
      watches,
      settings: { seconds: 5 },
      spawnCards: serverCards || { open: 0, unstarted: 0, nextDueAt: null, byAssistant: {} },
    },
    assistantThread: ASSISTANT_THREAD,
    assistantView: { assistant: "alerts" },
  };
  const api = new Function(
    "state",
    "as$",
    "esc",
    "fmtDur",
    "conversations",
    "sessionById",
    "assistantIds",
    "FIRST_ASSISTANT",
    "SPAWN_WATCH_MS",
    "waited",
    "oneLine",
    "parkedPicks",
    "stripRecommended",
    `${REGION}
return {
  renderAssistantAlerts,
  paintAssistantBadge,
  paintSpawnBadge,
  paintSpawnStrip,
  alertCounts,
  alertOwner,
  setWho: (v) => { alertWho = v; },
  who: () => alertWho,
};`,
  )(
    state,
    (id) => hosts.get(id) || null,
    esc,
    (n) => `${n}ms`,
    () => [],
    sessionById,
    assistantIds,
    PRIMARY_ASSISTANT,
    120_000,
    (n) => `${n}ms`,
    (s, n = 90) => String(s ?? "").slice(0, n),
    new Map(),
    (c) => String(c),
  );
  return {
    api,
    state,
    host: hosts.get("as-alerts"),
    strip: hosts.get("spawn-strip"),
    badge: hosts.get("assistant-badge"),
    spawnBadge: hosts.get("assistant-spawn-badge"),
  };
}

// Two notices and one waiting card, one per assistant — the shape the server's state() answer carries.
const ALERTS = [
  { id: "a1", key: "leftover|1", rule: "leftover", severity: "warn", title: "ONE-NOTICE", at: iso(30_000), status: "open", level: "alert", assistantId: "assistant-1", thread: "wtgui-worker-1" },
  { id: "a2", key: "leftover|2", rule: "leftover", severity: "warn", title: "TWO-NOTICE", at: iso(20_000), status: "open", level: "alert", assistantId: "assistant-2", thread: threadFor("assistant-2") },
  { id: "a3", key: "leftover|3", rule: "leftover", severity: "warn", title: "THREE-NOTICE", at: iso(10_000), status: "open", level: "alert", assistantId: "assistant-3", thread: threadFor("assistant-3") },
  {
    id: "c2",
    key: "spawn|2",
    rule: "spawn",
    severity: "info",
    title: "TWO-CARD",
    at: iso(5_000),
    status: "open",
    level: "alert",
    assistantId: "assistant-2",
    spawn: { prompt: "cut a tree for #2", existing: false, target: "agent-worktree-gui", project: "agent-worktree-gui" },
  },
];

test("a #2 thread's alert does not appear under #3's tab", () => {
  const p = alertsPane({ alerts: ALERTS });
  p.api.setWho("assistant-3");
  p.api.renderAssistantAlerts(true);
  assert.match(p.host.innerHTML, /THREE-NOTICE/, "#3's tab has #3's alert");
  assert.doesNotMatch(p.host.innerHTML, /TWO-NOTICE/, "and not #2's");
  assert.doesNotMatch(p.host.innerHTML, /data-alert="a2"/, "the #2 row is not in the DOM at all");

  p.api.setWho("assistant-2");
  p.api.renderAssistantAlerts(true);
  assert.match(p.host.innerHTML, /TWO-NOTICE/, "#2's tab has #2's");
  assert.doesNotMatch(p.host.innerHTML, /THREE-NOTICE/, "and not #3's");
  assert.doesNotMatch(p.host.innerHTML, /ONE-NOTICE/, "nor #1's");
});

test("the all view shows every assistant's alerts and hides nothing", () => {
  const p = alertsPane({ alerts: ALERTS });
  assert.equal(p.api.who(), "all", "the tab opens on All");
  p.api.renderAssistantAlerts(true);
  for (const title of ["ONE-NOTICE", "TWO-NOTICE", "THREE-NOTICE", "TWO-CARD"]) {
    assert.match(p.host.innerHTML, new RegExp(title), `the all view shows ${title}`);
  }
  assert.equal(p.api.alertCounts(ALERTS).notices, 3, "three notices, the spawn card counted apart");
  assert.equal(p.api.alertCounts(ALERTS).cards, 1, "one waiting card");
  assert.match(p.host.innerHTML, /data-as-alertwho="all"[^>]*aria-pressed="true"/, "the All chip is the one on");
  assert.match(p.host.innerHTML, /every assistant — nothing hidden/, "and it says so");
});

test("a legacy unowned alert lands under its thread's owner, not under #1 by default", async (t) => {
  // The payload is the SERVER's answer, so the resolution under test is the one the page is actually handed.
  const { assistant } = await panel(t, {
    alerts: [
      legacy({ id: "old-three", key: "leftover|old-three", thread: threadFor("assistant-3"), title: "OLD-THREE" }),
      legacy({ id: "old-worker", key: "leftover|old-worker", thread: "wtgui-worker-4", title: "OLD-WORKER" }),
    ],
  });
  const payload = assistant.state().alerts;

  const forThree = alertsPane({ alerts: payload });
  forThree.api.setWho("assistant-3");
  forThree.api.renderAssistantAlerts(true);
  assert.match(forThree.host.innerHTML, /OLD-THREE/, "#3's tab receives the legacy alert its thread names");
  assert.doesNotMatch(forThree.host.innerHTML, /OLD-WORKER/, "#1's legacy worker alert is not drawn on #3's tab");

  const forOne = alertsPane({ alerts: payload });
  forOne.api.setWho("assistant-1");
  forOne.api.renderAssistantAlerts(true);
  assert.match(forOne.host.innerHTML, /OLD-WORKER/, "a worker thread's legacy alert falls back to #1");
  assert.doesNotMatch(forOne.host.innerHTML, /OLD-THREE/, "and stays off #3's");
});

test("the counts and the spawn strip follow the same scope as the tab", () => {
  const p = alertsPane({ alerts: ALERTS });

  p.api.setWho("assistant-2");
  assert.deepEqual(p.api.alertCounts(ALERTS), { notices: 1, cards: 1 }, "#2's tab counts #2's notice and #2's card");
  p.api.renderAssistantAlerts(true);
  p.api.paintAssistantBadge();
  p.api.paintSpawnStrip();
  assert.equal(p.badge.textContent, "1", "the header badge counts #2's notices, not everyone's");
  assert.match(p.strip.innerHTML, /TWO-CARD/, "the strip draws #2's card");
  assert.doesNotMatch(p.strip.innerHTML, /ONE-NOTICE/, "and nothing from #1");
  assert.match(p.strip.innerHTML, /waiting for Assistant #2/, "the strip names whose cards it is showing");

  p.api.setWho("all");
  assert.deepEqual(p.api.alertCounts(ALERTS), { notices: 3, cards: 1 }, "All counts every assistant's");
  p.api.paintAssistantBadge();
  p.api.paintSpawnStrip();
  assert.equal(p.badge.textContent, "3", "the header badge goes back to the whole board");
  assert.match(p.strip.innerHTML, /1 spawn card waiting</, "the all strip is not narrowed");
  assert.doesNotMatch(p.strip.innerHTML, /waiting for Assistant/, "and does not name one assistant");
});

test("a narrowed badge reads the server's per-assistant count when the page has no rows yet", () => {
  // A socket replay of `state` can land before any tab repainted its list: then the page has no rows and the
  // server's number is what the badge shows. It has to be the SCOPE's number, or a panel-wide total comes back.
  const p = alertsPane({
    alerts: [],
    serverCards: { open: 7, unstarted: 2, nextDueAt: null, byAssistant: { "assistant-2": { open: 2, unstarted: 1, nextDueAt: null } } },
  });
  p.api.setWho("assistant-2");
  p.api.paintSpawnBadge();
  assert.equal(p.spawnBadge.textContent, "2 spawn", "#2's count, not the board's seven");
  assert.match(p.spawnBadge.title, /1 never started/, "and #2's unstarted count");

  p.api.setWho("assistant-3");
  p.api.paintSpawnBadge();
  assert.equal(p.spawnBadge.hidden, true, "an assistant with no cards has no badge");
});
