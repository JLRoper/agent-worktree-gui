// Does the gateway this panel is pointed at carry the Runs API half of the `clarify` contract?
//
// The panel's own half (the light-purple question box, `POST /api/jobs/answer`, the `clarify.request`
// handling in lib/jobs.js) ships in this repo. The gateway's half is code: a build needs a route to
// answer a parked question (`POST /v1/runs/{run_id}/clarify`) and a clarify callback on an API run's
// agent. Without them the model is still handed the tool — `platform_toolsets.api_server` can add it —
// and every call is refused with "Clarify tool is not available in this execution context", which
// looks like a permission problem and is a missing feature.
//
// A build that has it advertises `features.run_clarify_response` in /v1/capabilities, and that flag is
// the cheapest honest answer this script can read. The stock 0.22.2 build does not have the route, and
// this box carries it as a LOCAL PATCH rather than an upstream install: the four edits, the apply
// script and the restart step are in docs/clarify-over-the-runs-api.md.
//
//   node tools/check-gateway-clarify.mjs                 # capabilities only: one GET, no guessing
//   node tools/check-gateway-clarify.mjs --probe         # + one OPTIONS per route, to tell a route
//                                                        #   that is absent from one that is present
//   node tools/check-gateway-clarify.mjs --url http://host:8642 --key <API_SERVER_KEY>
//
// Read-only: nothing is started, stopped or written, and no run is created. Exit code is the answer —
// 0 the route is there, 1 it is not, 2 undecided (an auth layer answered first, or nothing did).
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

function hermesHome() {
  return process.env.HERMES_HOME || process.env.HERMES_HOME_DIR || path.join(os.homedir(), ".hermes");
}

function keyFromEnvFile() {
  try {
    const p = path.join(hermesHome(), ".env");
    if (!existsSync(p)) return null;
    const m = /^\s*API_SERVER_KEY\s*=\s*(.+?)\s*$/m.exec(readFileSync(p, "utf8"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") || null : null;
  } catch {
    return null;
  }
}

function configFromPanel() {
  // Beside the panel, the same file server.js reads; a key in it is a key the panel already uses.
  for (const p of ["config.json", "panel-config.json"]) {
    try {
      if (!existsSync(p)) continue;
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      if (cfg?.apiServer?.url || cfg?.apiServer?.key) return cfg.apiServer;
    } catch {
      /* a config that will not parse is not this script's problem */
    }
  }
  return {};
}

const cfg = configFromPanel();
const url = String(value("--url") || process.env.API_SERVER_URL || cfg.url || "http://127.0.0.1:8642").replace(/\/+$/, "");
const key = String(value("--key") || process.env.API_SERVER_KEY || cfg.key || keyFromEnvFile() || "");
const headers = key ? { Authorization: `Bearer ${key}` } : {};

const out = [];
const say = (line = "") => out.push(line);

say(`gateway  ${url}`);
say(`auth     ${key ? "API_SERVER_KEY present" : "no key found (set --key, API_SERVER_KEY, or $HERMES_HOME/.env)"}`);

let verdict = 2;
let reason = "nothing answered the probe";
// What the gateway says about itself. null = this build says nothing either way.
let flagPresent = null;

try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  const res = await fetch(`${url}/v1/capabilities`, { headers, signal: ctrl.signal });
  clearTimeout(t);
  if (!res.ok) {
    say(`capabilities  HTTP ${res.status} — the panel cannot read this gateway's feature list either`);
    reason = `capabilities answered HTTP ${res.status}`;
  } else {
    const caps = await res.json();
    const features = caps.features || {};
    const endpoints = caps.endpoints || {};
    say(`version   ${caps.version || "(not reported)"}`);
    say(`features  ${Object.entries(features).filter(([, v]) => v === true).map(([k]) => k).join(", ") || "(none true)"}`);
    flagPresent = features.run_clarify_response === true;
    say(`clarify   ${flagPresent ? "advertised (run_clarify_response)" : "not advertised — a build may still have the route, so this is a hint, not proof"}`);
    // A build that ships the route is free not to advertise it; the absence below is a hint, not proof.
    const advertised = Object.keys(endpoints).filter((name) => /clarif/i.test(name) || /clarify$/.test(String(endpoints[name]?.path || "")));
    say(`advertised clarify endpoints: ${advertised.length ? advertised.join(", ") : "none (the stock build does not advertise one either)"}`);
    if (flagPresent) {
      // The gateway's own statement, and the one signal here that does not depend on how a router
      // answers a method it was never asked to serve.
      verdict = 0;
      reason = "the gateway advertises run_clarify_response — the Runs API clarify contract is present";
    }
  }
} catch (e) {
  say(`capabilities  unreachable — ${String((e && e.message) || e)}`);
  reason = "the gateway did not answer /v1/capabilities";
}

if (flag("--probe")) {
  // A path that exists but does not accept OPTIONS answers 405; a path the router does not know
  // answers 404. The approval route is the control: this panel uses it, so a 404 there means the
  // probe itself is being answered by something other than the router (an auth layer, a proxy).
  const probe = async (suffix) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${url}/v1/runs/__capability-probe__${suffix}`, { method: "OPTIONS", headers, signal: ctrl.signal });
      clearTimeout(t);
      return res.status;
    } catch (e) {
      return `no answer (${String((e && e.message) || e)})`;
    }
  };
  const [control, clarify] = [await probe("/approval"), await probe("/clarify")];
  say();
  say(`OPTIONS /v1/runs/__capability-probe__/approval  -> ${control}   (control)`);
  say(`OPTIONS /v1/runs/__capability-probe__/clarify   -> ${clarify}`);
  // 404 is the router saying it has no such path; 405 is the router saying it has the path but not for
  // OPTIONS; a status from a handler (200/400/409) means the path reached code. 401/403 and a dead
  // socket mean something in front of the router answered, which settles nothing either way.
  const routeKnown = (code) => (code === 405 || code === 200 || code === 400 || code === 409 ? true : code === 404 ? false : null);
  if (flagPresent === true) {
    // The flag already answered; the probe only has to agree with it. A disagreement is worth saying
    // out loud rather than smoothing over — one of the two readings is stale.
    if (routeKnown(clarify) === false) {
      verdict = 2;
      reason = "the capability flag says the route is there, but the router answered 404 for it — re-read before believing either";
    } else if (routeKnown(clarify) === true) {
      reason = "the gateway advertises run_clarify_response and the router knows /v1/runs/{id}/clarify";
    }
  } else if (routeKnown(control) === false) {
    reason = "the control route answered 404 too — an auth layer or a proxy is answering, not the router";
  } else if (routeKnown(clarify) === true) {
    verdict = 0;
    reason = "the router knows /v1/runs/{id}/clarify";
  } else if (routeKnown(clarify) === false) {
    verdict = 1;
    reason = "the router does not know /v1/runs/{id}/clarify on this build";
  } else {
    // Measured on this box: BOTH probes answer 403 (an auth layer answers before the router), so a
    // bare "undecided" here reads like a broken script. Say which two answers were the same.
    const same = String(clarify) === String(control);
    reason = `undecided: the clarify probe answered ${clarify}`
      + (same ? ` — and so did the approval control (${control}), so something in front of the router answered and the probe settles nothing` : "");
  }
}

say();
say(`VERDICT   ${verdict === 0 ? "the clarify route is present" : verdict === 1 ? "the clarify route is ABSENT on this build" : "undecided"}`);
say(`          ${reason}`);
if (verdict !== 0) {
  say();
  say("The panel's half is already written and needs no change. The gateway's half is code, not config:");
  say("  `hermes config set platform_toolsets.api_server` only puts the tool in the schema — it cannot add the route.");
  say("  A build without it can be given it locally, which is what this box does:");
  say("    %LOCALAPPDATA%\\hermes\\patches\\clarify-runs-api.patch      (patch -p1; delete the stale __pycache__)");
  say("    %LOCALAPPDATA%\\hermes\\patches\\clarify-runs-api.apply.py   (re-runnable; asserts every anchor)");
  say("  Apply it to BOTH copies — hermes-agent/ and installs/*/environments/*/workspace/ — then restart the");
  say("  gateway: a running process keeps the modules it loaded at boot. There is no restart button in the page;");
  say("  the assistant's `RESTART gateway` line, or POST /api/restart {\"target\":\"gateway\",\"waitFor\":\"<thread>\"},");
  say("  queues it until the asking turn has ended.");
  say("  `hermes update` installs a build with the contract too — the heavier path, and it restarts the gateway.");
  say("  docs/clarify-over-the-runs-api.md has the quoted code, the patch's four edits, and what the panel does");
  say("  until then: it records the refusal from a run's own stream and tells agents to ask in prose.");
}
if (!flag("--probe")) {
  say();
  say("Run again with --probe to ask the router directly (one OPTIONS per route, still read-only).");
}

console.log(out.join("\n"));
process.exitCode = verdict;
