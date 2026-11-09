// The host hold (lib/remote-backoff.js): the threshold, the doubling, the cap, the reset — and the
// classifier that keeps a per-repo answer from muting every other repo on a host.
import assert from "node:assert/strict";
import test from "node:test";
import { configure, reset, heldBack, failed, answered, looksLikeHostTrouble } from "../lib/remote-backoff.js";
import { prIndex } from "../lib/project.js";
import { DEFAULT_SEED_FILE, readHostsFile } from "../lib/hosts.js";

let at = 1_000_000_000;
const lines = [];
configure({ clock: () => at, sink: (line) => lines.push(line) });

test("one failure is just noise; the second holds the host for a minute — and says so once", () => {
  reset(); lines.length = 0;
  failed("sefl-bitbucket", "ssh: connect to host git.sefl.com port 22: Connection timed out");
  assert.equal(heldBack("sefl-bitbucket"), false, "a single failure holds nothing");
  failed("sefl-bitbucket", "ssh: connect to host git.sefl.com port 22: Connection timed out");
  const hold = heldBack("sefl-bitbucket");
  assert.ok(hold, "the second consecutive failure holds the host");
  assert.equal(hold.ms, 60_000);
  assert.match(lines.join("\n"), /sefl-bitbucket is not answering .*held back for 1 min/, "the hold is said out loud");
});

test("the hold doubles per failure and stops at half an hour", () => {
  reset();
  failed("h", "x"); failed("h", "x");      // 1 min
  at += 60_000; failed("h", "x");          // the probe failed: 2 min
  assert.equal(heldBack("h").ms, 120_000);
  at += 120_000; failed("h", "x");         // 4 min
  assert.equal(heldBack("h").ms, 240_000);
  at += 240_000; failed("h", "x");         // 8 min
  assert.equal(heldBack("h").ms, 480_000);
  at += 480_000; failed("h", "x");         // 16 min
  assert.equal(heldBack("h").ms, 960_000);
  at += 960_000; failed("h", "x");         // 32 min asked, 30 given
  assert.equal(heldBack("h").ms, 30 * 60_000);
  at += 30 * 60_000; failed("h", "x");     // still 30
  assert.equal(heldBack("h").ms, 30 * 60_000);
});

test("expiry lets exactly the probe through", () => {
  reset();
  failed("h", "x"); failed("h", "x");
  const hold = heldBack("h");
  assert.ok(hold && hold.ms > 0, "held now");
  at += hold.ms;
  assert.equal(heldBack("h"), false, "the moment the hold expires one attempt is allowed");
});

test("an answer clears the count — the next failure starts over", () => {
  reset();
  failed("h", "x"); failed("h", "x");
  assert.ok(heldBack("h"));
  answered("h");
  assert.equal(heldBack("h"), false, "healthy again");
  failed("h", "x");
  assert.equal(heldBack("h"), false, "one fresh failure holds nothing");
});

test("only the shapes a down host makes hold the host", () => {
  assert.equal(looksLikeHostTrouble("The operation was aborted due to timeout"), true);
  assert.equal(looksLikeHostTrouble("ssh: connect to host git.sefl.com port 22: Connection timed out"), true);
  assert.equal(looksLikeHostTrouble("fetch failed"), true);
  assert.equal(looksLikeHostTrouble("connect ECONNREFUSED 165.166.160.234:443"), true);
  assert.equal(looksLikeHostTrouble("getaddrinfo ENOTFOUND git.sefl.com"), true);
  assert.equal(looksLikeHostTrouble("GraphQL: Could not resolve to a Repository with the name '59055_SEFL/jlr-test-repo'. (repository)"), false, "a per-repo answer is not a host outage");
  assert.equal(looksLikeHostTrouble("HTTP 404 from https://git.sefl.com/rest/api/1.0/projects/IT/repos/menu/pull-requests?state=ALL&limit=100"), false);
  assert.equal(looksLikeHostTrouble("no token in BITBUCKET_SEFL_TOKEN"), false);
});

test("a held host is not asked: prIndex answers empty without a socket", async () => {
  reset();
  failed("sefl-bitbucket", "x"); failed("sefl-bitbucket", "x");
  assert.ok(heldBack("sefl-bitbucket"));
  const seed = readHostsFile(DEFAULT_SEED_FILE);
  const doc = {
    ...seed,
    projects: { ...(seed.projects || {}), "email-multi": { host: "sefl-bitbucket", coordinates: { projectKey: "IT", repoSlug: "email-multi" } } },
  };
  const project = { name: "email-multi", path: "C:/nope", host: "sefl-bitbucket", remote: "origin" };
  let calls = 0;
  const realFetch = globalThis.fetch;
  const realToken = process.env.BITBUCKET_SEFL_TOKEN;
  globalThis.fetch = () => { calls += 1; throw new Error("fetch must not be reached while the host is held"); };
  process.env.BITBUCKET_SEFL_TOKEN = "test-token";
  try {
    const index = await prIndex(project, 60, doc);
    assert.equal(calls, 0, "no fetch while held");
    assert.equal(index.byRef.size, 0, "the board reads the empty index it would read after a failed list");
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.BITBUCKET_SEFL_TOKEN; else process.env.BITBUCKET_SEFL_TOKEN = realToken;
  }
});

test("two timed-out list reads hold the host, and the third call never reaches fetch", async () => {
  reset();
  const seed = readHostsFile(DEFAULT_SEED_FILE);
  const doc = {
    ...seed,
    projects: { ...(seed.projects || {}), "fleet-kafka": { host: "sefl-bitbucket", coordinates: { projectKey: "SA", repoSlug: "fleet-kafka" } } },
  };
  const project = { name: "fleet-kafka", path: "C:/nope", host: "sefl-bitbucket", remote: "origin" };
  let calls = 0;
  const realFetch = globalThis.fetch;
  const realToken = process.env.BITBUCKET_SEFL_TOKEN;
  globalThis.fetch = () => { calls += 1; return Promise.reject(new Error("The operation was aborted due to timeout")); };
  process.env.BITBUCKET_SEFL_TOKEN = "test-token";
  try {
    await prIndex(project, 0, doc); // ttl 0: every call runs the factory — call 1 fails, the hold still needs a second
    assert.equal(calls, 1, "the first read tried");
    await prIndex(project, 0, doc); // call 2 fails: the hold begins
    assert.equal(calls, 2, "the second read tried");
    assert.ok(heldBack("sefl-bitbucket"), "two host-class failures hold the host");
    const index = await prIndex(project, 0, doc);
    assert.equal(calls, 2, "the held read never reached fetch");
    assert.equal(index.byRef.size, 0);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.BITBUCKET_SEFL_TOKEN; else process.env.BITBUCKET_SEFL_TOKEN = realToken;
  }
});
