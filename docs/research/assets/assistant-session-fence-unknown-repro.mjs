// Minimal reproduction: a panel card whose run the gateway answers `unknown`.
//   node docs/research/assets/assistant-session-fence-unknown-repro.mjs
//
// The stub gateway answers the poll exactly as gateway/platforms/api_server_authority_runs.py:run_projection
// does for an ``unknown`` admission: status "unknown" (not terminal), plus the two values that would lift it.
// The panel's poll() is driven, and every request the panel makes is recorded.
import { createServer } from "node:http";

import { Jobs } from "../../../lib/jobs.js";

const seen = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push(`${req.method} ${req.url}${body ? ` ${body}` : ""}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/runs/run_unknown") {
      // run_projection: status 'unknown', generation, admission id, no pending controls.
      res.end(JSON.stringify({
        run_id: "run_unknown",
        status: "unknown",
        admission_id: "adm_01",
        execution_generation: 7,
        pending_controls: [],
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/runs/run_unknown/resolve-unknown") {
      res.end(JSON.stringify({ run_id: "run_unknown", status: "terminal", outcome: "interrupted" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: "no such route" } }));
  });
});

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${stub.address().port}`;

const jobs = new Jobs({ config: { apiServer: { url } }, onEvent: () => {} });
const j = { id: "p1", thread: "wtgui-fence", runId: "run_unknown", status: "running", startedAt: new Date().toISOString(), lines: [] };
jobs.jobs.set(j.id, j);

// The panel's poller, on its 15s clock: what it does with the gateway's `unknown`.
await jobs.poll(j);

console.log("after poll(status=unknown):");
console.log("  card status      :", j.status);
console.log("  settle called     :", j.status === "done" || j.status === "failed" || j.status === "cancelled" || j.status === "interrupted");
console.log("  requests made     :", JSON.stringify(seen, null, 2));

// The call the panel never makes, with the two values the GET already returned.
const get = await fetch(`${url}/v1/runs/run_unknown`, { headers: jobs.headers() });
const run = await get.json();
const resolve = await fetch(`${url}/v1/runs/run_unknown/resolve-unknown`, {
  method: "POST",
  headers: jobs.headers(),
  body: JSON.stringify({ admission_id: run.admission_id, execution_generation: run.execution_generation }),
});
console.log("\nthe repair, driven by hand:");
console.log("  POST resolve-unknown ->", resolve.status, JSON.stringify(await resolve.json()));
console.log("  requests total      :", seen.length);

stub.close();
