// The SPAWN pre-flight is answered by the SERVER's own wiring, not by a fixture's idea of it.
//
// Why this file exists: routes/assistant-spawn-check.js already had tests, and every one of them built the route with
// `getProjects: () => [project]` (test/spawn-check.test.js). The ONE accessor no test ran was the one in server.js's
// mount table, and that line passed `() => registry.list()`. The registry's `list` is the ARRAY it caches at boot
// (lib/projects.js, `this.list = this.loadCache()`), not a method, so the call threw inside the route's try/catch and
// the transport answered every pre-flight with "the panel could not answer that: registry.list is not a function".
//
// Two guards, because either alone would miss a different half of a drift:
//
//   1. THE WIRE: boot the real server.js (tools/panel-testkit.mjs) and call the route. A 500 here IS the defect; a 200
//      with a verdict is the fix. This fails on `() => registry.list()` and passes on the shared accessor.
//   2. THE SOURCE: every `getProjects:` accessor in server.js must be the SAME shape, and that shape must answer an
//      array for the object ProjectRegistry really is - a `projects` getter and `list` as an ARRAY. One shared shape
//      is what makes a second spelling impossible to add quietly: the next editor gets a red test, not a 500.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ROOT, startPanel } from "../tools/panel-testkit.mjs";
import { projectsOf } from "../lib/projects.js";

// Every accessor this file hands to a consumer, as written. Deliberately a source read: the defect was a line of
// WIRING, and a route built by a test cannot see it. Line comments are stripped so the file may still explain the
// defect it fixed; every accessor must then be readable by the pattern, which the count check below enforces.
function accessorsInServer() {
  const src = readFileSync(path.join(ROOT, "server.js"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "");
  const found = [...code.matchAll(/getProjects:\s*(\(\)\s*=>\s*[^,}\n]+)/g)].map((m) => m[1].trim().replace(/\s+/g, " "));
  return { src, code, found, declared: (code.match(/getProjects:/g) || []).length };
}

test("every getProjects accessor in server.js has the same shape, and it reads the registry's projects getter", () => {
  const { code, found, declared } = accessorsInServer();
  assert.ok(found.length >= 4, `server.js hands a project accessor to several consumers; saw ${found.length}`);
  assert.equal(found.length, declared, "every `getProjects:` accessor is one this guard can read: write it as an arrow");
  // ONE shape. The spawn-check row, the Assistant, the Scheduler and the Element channel are one implementation of
  // "what projects does this panel have", so no two of them can disagree about it.
  assert.deepEqual(
    [...new Set(found)],
    ["() => projectsOf(registry)"],
    `every project accessor must be "() => projectsOf(registry)"; saw ${JSON.stringify([...new Set(found)])}`,
  );
  // ...AND that shape answers the array on the object the registry actually is: `projects` is a getter over the
  // discovery cache, and `list` is the cached ARRAY. The old line called `list()` here and threw.
  const registry = { projects: [{ name: "proj", path: "proj" }], list: [] };
  const accessor = new Function("registry", "projectsOf", `return (${found[0]});`)(registry, projectsOf);
  assert.deepEqual(accessor(), registry.projects, "the accessor answers the discovered list");
  assert.deepEqual(projectsOf({ list: [] }), [], "a registry that has discovered nothing answers empty, never throws");
  assert.deepEqual(projectsOf(null), [], "and a missing registry is empty rather than a TypeError in a route's try/catch");
  // The exact defect, as a rule: `list` is data, not a method. Comments may NAME the old spelling (this file's own
  // account of the defect does), so the rule reads the code with line comments stripped.
  assert.ok(!/registry\.list\s*\(/.test(code), "server.js must never call registry.list(): list is the cached ARRAY, not a method");
  assert.ok(!found.some((expr) => /\.list\s*\(/.test(expr)), "and no accessor calls a list() method on anything");
});

test("the server-mounted SPAWN pre-flight answers a verdict, not the transport's 500", async (t) => {
  const token = "spawn-check-wiring-token";
  const panel = await startPanel({ token });
  t.after(() => panel.stop());
  const ask = (query) => fetch(`${panel.base}/api/assistant/spawn-check?${query}`, { headers: { "x-panel-token": token } });

  // A task the panel cannot find still has a verdict: ok:false with a reason and a remedy. What it must NOT be is
  // the transport's "the panel could not answer that: registry.list is not a function", which is what the old
  // accessor produced for every call, this one included.
  const missing = await ask("task=987654");
  const missingBody = await missing.json();
  assert.equal(missing.status, 200, `a pre-flight is a read and answers 200: ${JSON.stringify(missingBody)}`);
  assert.equal(missingBody.ok, false, "an unknown row is a refusal, not a crash");
  assert.ok(Array.isArray(missingBody.checks) && missingBody.checks.length > 0, "the answer carries the check it made");
  assert.match(String(missingBody.reason || ""), /no task #987654/, "the reason names the row");
  assert.match(String(missingBody.remedy || ""), /^file the row first/, "and the remedy names the fix");
  assert.equal(missingBody.error, undefined, "no transport error field: the route answered");

  // The accepting case, through the same wire: a queued row with nothing against it answers ok:true. The route reads
  // the project list on the way (`projectsOf()`), so this is the same accessor, on the accepting path.
  const added = await fetch(`${panel.base}/api/assistant/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-panel-token": token },
    body: JSON.stringify({ action: "add", title: "the wiring guard's own row" }),
  });
  const queued = await added.json();
  assert.equal(added.status, 200, `the queue accepted the row: ${JSON.stringify(queued)}`);
  const id = queued?.task?.id ?? queued?.id;
  assert.ok(Number.isInteger(Number(id)) && Number(id) > 0, `the queue named the row it made: ${JSON.stringify(queued)}`);

  const free = await ask(`task=${id}`);
  const freeBody = await free.json();
  assert.equal(free.status, 200, `the accepting pre-flight answers 200: ${JSON.stringify(freeBody)}`);
  assert.equal(freeBody.ok, true, `a queued row with no live run can start: ${JSON.stringify(freeBody)}`);
  assert.equal(freeBody.reason, null);
  assert.equal(freeBody.remedy, null);
  assert.deepEqual(freeBody.checks, []);
  assert.equal(Number(freeBody.task), Number(id), "and the answer echoes the row that was asked about");

  // The server's log must not carry the failure either: a 200 built over a caught throw is still a broken answer.
  assert.ok(!/registry\.list is not a function/.test(panel.log()), "the server never logged the broken accessor");
});
