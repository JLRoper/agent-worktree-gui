// The Assistant Director on a running panel: the role in the library, an assistant made from it, and the tab's
// three reads.
//
//   node tools/verify-assistant-director.mjs
//
// A sandbox panel of its own (tools/panel-testkit.mjs) — no gateway, no real state, no browser — and five checks:
//
//   1. `GET /api/roles` lists both built-ins and the Director is there with its remit and its size, and the list
//      carries no charter text;
//   2. `POST /api/assistant/assistants` with `roleId: "assistant-director"` creates Assistant #2 on that role;
//   3. the Role tab's read (`GET /api/assistant/role?assistantId=…`) carries the Director's name, the roleId, the
//      charter text byte for byte, and `wakeEveryMinutes: 20`;
//   4. the Queue tab's read (`GET /api/assistant/queue?assistantId=…`) says `found: true` with no tasks — an empty
//      FILE, not a missing one;
//   5. the assistant's own state says the interval and the `spawn: "off"` gate.
//
// Every check prints PASS/FAIL; the exit code is 1 if any failed. The role's own charter file and the idempotent
// boot registration are unit-tested in test/assistant-director.test.js, which does not need a server.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startPanel } from "./panel-testkit.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 120_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing — see the last line printed above.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

const ROLE_ID = "assistant-director";
const CHARTER = readFileSync(new URL("../data/roles/assistant-director.md", import.meta.url), "utf8");
const CAP = 20_000;

let failures = 0;
let checks = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const getJson = async (base, route) => {
  const r = await fetch(`${base}${route}`);
  return { status: r.status, json: await r.json().catch(() => null) };
};
const postJson = async (base, route, body) => {
  const r = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-director-verify-"));
let panel = null;
try {
  panel = await startPanel({ dir, config: { assistant: { enabled: false, seconds: 3600 } } });
  console.log(`panel: ${panel.base} (sandbox ${dir})`);

  // 1. the library
  const roles = await getJson(panel.base, "/api/roles");
  ok("GET /api/roles answers 200", roles.status === 200, String(roles.status));
  const director = (roles.json?.roles || []).find((r) => r.id === ROLE_ID);
  ok("Assistant Director is listed", Boolean(director));
  if (director) {
    ok("its name is Assistant Director", director.name === "Assistant Director");
    ok("its remit names the 20-minute wake", /20 minutes/.test(director.description));
    ok("its charter is the repo's file", director.chars === CHARTER.length, `${director.chars}/${CHARTER.length}`);
    ok("it fits the cap", director.chars > 0 && director.chars <= CAP && director.over === false);
    ok("the list carries no charter text", director.charter === undefined);
  }
  ok("the manager is still there", (roles.json?.roles || []).some((r) => r.id === "agent-manager"));

  // 2. an assistant made from it
  const made = await postJson(panel.base, "/api/assistant/assistants", { roleId: ROLE_ID });
  ok("POST /api/assistant/assistants answers 201", made.status === 201, String(made.status));
  const id = made.json?.created?.id;
  ok("it created Assistant #2", id === "assistant-2", String(id));
  ok("the record carries the roleId", made.json?.created?.roleId === ROLE_ID);

  // 3. the Role tab's read
  const tab = await getJson(panel.base, `/api/assistant/role?assistantId=${encodeURIComponent(id)}`);
  ok("GET /api/assistant/role answers 200", tab.status === 200, String(tab.status));
  ok("the tab names the role", tab.json?.role?.name === "Assistant Director");
  ok("the target carries the roleId", tab.json?.target?.roleId === ROLE_ID);
  ok("the tab reads wakeEveryMinutes 20", tab.json?.wakeEveryMinutes === 20, String(tab.json?.wakeEveryMinutes));
  ok("the tab reads the charter whole", tab.json?.charter?.text === CHARTER, `${tab.json?.charter?.text?.length || 0} chars`);
  ok("the copy is the role's own text", tab.json?.sameAsRole === true);

  // 4. the Queue tab's read
  const queue = await getJson(panel.base, `/api/assistant/queue?assistantId=${encodeURIComponent(id)}`);
  ok("GET /api/assistant/queue answers 200", queue.status === 200, String(queue.status));
  ok("the queue EXISTS (empty rather than missing)", queue.json?.queue?.found === true);
  ok("it carries no tasks", Array.isArray(queue.json?.queue?.tasks) && queue.json.queue.tasks.length === 0);
  ok("its counts say zero", queue.json?.queue?.counts?.total === 0);

  // 5. the assistant's own state
  const state = await getJson(panel.base, "/api/assistant");
  const rec = (state.json?.assistants || []).find((a) => a.id === id);
  ok("the state lists its interval", rec?.wakeEveryMinutes === 20, JSON.stringify(rec?.wakeEveryMinutes));
  ok("the SPAWN gate is off", state.json?.assistantSettings?.[id]?.spawn === "off", JSON.stringify(state.json?.assistantSettings?.[id]?.spawn));
} catch (err) {
  failures += 1;
  console.error(`FAIL  the run threw — ${String((err && err.stack) || err)}`);
} finally {
  clearTimeout(watchdog);
  try {
    if (panel) await panel.stop();
  } catch {
    /* the sandbox may already be gone */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a process may still hold the directory; the temp dir prunes itself */
  }
  console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : " — all good"}`);
  process.exitCode = failures ? 1 : 0;
}
