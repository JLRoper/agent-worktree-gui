// One gateway key, resolved in one place.
//
// The panel's gateway clients used to disagree about where the key lives: lib/jobs.js fell back to
// `<HERMES_HOME>/.env` after `apiConfig()`, and lib/hermes-models.js and lib/gateway-permissions.js never did — so
// on a panel with no `apiServer.key` in config.json (the normal case) those two sent no Authorization header and the
// gateway answered 401. Measured on one live gateway: 3,748 "rejected invalid API key" lines, 1,862 of them on
// /v1/capabilities, 999 on /v1/skills, 812 on /api/model/options and 18 on /v1/runs.
//
// This is the contract: config file first, then the environment, then the install's own `.env` — and never a guess.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { apiConfig } from "../lib/hermes-runtime.js";

async function homeWithEnv(t, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-key-"));
  const home = path.join(dir, "hermes");
  await mkdir(home, { recursive: true });
  if (body !== null) await writeFile(path.join(home, ".env"), body);
  const hadHome = process.env.HERMES_HOME;
  const hadKey = process.env.API_SERVER_KEY;
  process.env.HERMES_HOME = home;
  delete process.env.API_SERVER_KEY;
  t.after(async () => {
    if (hadHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = hadHome;
    if (hadKey === undefined) delete process.env.API_SERVER_KEY;
    else process.env.API_SERVER_KEY = hadKey;
    await rm(dir, { recursive: true, force: true });
  });
  return home;
}

test("a config file that names no key falls through to the install's .env", async (t) => {
  await homeWithEnv(t, "API_SERVER_KEY=from-the-env-file\n");
  assert.equal(apiConfig({}).key, "from-the-env-file", "this is the fallback that stops the 401s");
  assert.equal(apiConfig({ apiServer: { key: "" } }).key, "from-the-env-file", "an empty string is not a key");
});

test("an explicit key beats the file, and the environment beats both", async (t) => {
  await homeWithEnv(t, "API_SERVER_KEY=from-the-env-file\n");
  assert.equal(apiConfig({ apiServer: { key: "explicit-in-config" } }).key, "explicit-in-config");
  process.env.API_SERVER_KEY = "from-the-process";
  assert.equal(apiConfig({}).key, "from-the-process", "a panel started with the key exported uses it");
});

test("no key anywhere is null, not a made-up one", async (t) => {
  await homeWithEnv(t, null, {});
  assert.equal(apiConfig({}).key, null);
  assert.equal(apiConfig({ apiServer: { url: "http://127.0.0.1:9999/" } }).url, "http://127.0.0.1:9999", "the URL is still normalised");
});

test("quotes around the value are stripped", async (t) => {
  await homeWithEnv(t, 'API_SERVER_KEY="quoted-key"\n');
  assert.equal(apiConfig({}).key, "quoted-key");
});
