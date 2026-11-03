// `config.json` is written atomically: a reader looking at it while a setting is saved sees the whole old file or
// the whole new one, never a torn one.
//
// What it was: `patchPanelConfig` wrote the file IN PLACE (`writeFile`), which truncates the target before the new
// bytes land. A reader that arrived in that window parsed an empty or half-written file and threw
// `Unexpected end of JSON input` — a failure that reads as the READER's bug, which is how this class hides. Measured
// on the un-fixed writer: a reader looping over the file beside 40 saves caught it 35 times of 181 reads, and it
// cost an unrelated card a flaky harness run before anybody looked.
//
// What it is now: the text goes to a sibling temp file in the SAME directory (same directory is what makes the
// rename atomic — a different directory can be a different volume, and a cross-volume move is a copy) and is renamed
// over the target. The bytes are unchanged: the same `JSON.stringify(raw, null, 2)`, the same single trailing
// newline, the same key order, so the file stays as diff-friendly as it was. Only HOW it is replaced changed.
//
// The Windows half, which is why the writer retries: a rename whose DESTINATION another handle is READING is refused
// with EPERM on this filesystem, even when that handle is a plain `readFile` — measured, one reader looping over the
// target refused 244 of 300 replaces and one handle held open refused all 300, while the same loop against another
// file refused none. The read it competes with lasts a fraction of a millisecond, so the refusal is transient and a
// bounded retry lands the save. Both halves are load-bearing, and this test is what says so: a plain rename with no
// retry fails the "every save answered 200" check, and an in-place write fails the "no torn read" one.
//
// NOT asserted here, and still open: two settings saved at the same MOMENT can lose one of the two. `patchPanelConfig`
// is a read-modify-write (read the file, assign the key, write it back), so two overlapping saves both read the same
// base and the second write wins alone — measured on this fixed tree, 1 of 20 concurrent pairs answered 200 on both
// requests while the file kept only one of the two keys. The atomic replace does not fix that (it slightly widens the
// window, as any writer with a retry would); serialising the saves would, and that is a change to WHAT the writer
// does rather than how, so it is reported rather than smuggled in here.
//
// Everything here runs against a sandbox panel of its own (tools/panel-testkit.mjs): its own port, config, store and
// HERMES_HOME, with apiServer pointed at a dead port so no phase can reach the live gateway. :7331 is never touched.
// The reader is deliberately not given a breather between reads — a reader that hammers is the worst case the write
// has to survive — so the file is kept to ONE panel and its phases read the same file, to stay cheap for the rest of
// the suite.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { post, startPanel } from "../tools/panel-testkit.mjs";

// Enough saves that the reader gets many chances at the window, few enough that the suite stays quick: the old writer
// tore dozens of times over (it truncated every one of these saves), and the fixed one spends a few milliseconds a
// save on the retries.
const WRITES = 40;
const MIN_READS = 100; // a reader that never ran must not read as "no torn read"

// A reader in a tight loop over the panel's config.json, recording every parse failure verbatim. It is started
// beside the writes and stopped with `stopAndWait`, which the caller awaits before reading the file itself.
function startReader(configPath) {
  const seen = { reads: 0, torn: 0, errors: new Map(), shapes: new Set(), first: null };
  let stop = false;
  const done = (async () => {
    while (!stop) {
      let text;
      try {
        text = await readFile(configPath, "utf8");
      } catch {
        continue; // the file being replaced under a reader is the point; a miss is not a torn read
      }
      seen.reads += 1;
      try {
        const doc = JSON.parse(text);
        // A parsed document is a WHOLE one (a truncated JSON object cannot parse), and this is the second half of
        // the claim: it is one of the documents this test wrote, not some third shape.
        seen.shapes.add(Object.keys(doc).join(","));
      } catch (e) {
        seen.torn += 1;
        const msg = String((e && e.message) || e);
        seen.errors.set(msg, (seen.errors.get(msg) || 0) + 1);
        if (!seen.first) seen.first = { length: text.length, tail: text.slice(-40), message: msg };
      }
    }
  })();
  return {
    seen,
    async stopAndWait() {
      stop = true;
      await done;
    },
  };
}

const noTornRead = (reader) =>
  assert.deepEqual(
    [...reader.seen.errors.entries()],
    [],
    reader.seen.torn
      ? `a reader caught a torn file ${reader.seen.torn} times of ${reader.seen.reads} reads — first: ${JSON.stringify(reader.seen.first)}`
      : "",
  );

const noStrays = (dir) =>
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith(".tmp")),
    [],
    "no temp file survives a save",
  );

test("config.json is saved atomically: a concurrent reader never sees it torn, and no temp file survives", async () => {
  const panel = await startPanel({
    config: { apiServer: { url: "http://127.0.0.1:9" }, assistant: { enabled: false } },
  });
  const configPath = panel.configPath;
  const configDir = path.dirname(configPath);
  // The fixture as the panel left it: the key order every later write has to preserve, and the base for the
  // byte-for-byte comparison below.
  const before = JSON.parse(readFileSync(configPath, "utf8"));
  const reader = startReader(configPath);

  try {
    const statuses = [];
    for (let i = 0; i < WRITES; i++) {
      const r = await post(panel.base, "/api/settings/age", { body: { days: (i % 2) + 1 } });
      statuses.push(r.status);
    }
    await reader.stopAndWait();

    const notOk = statuses.filter((s) => s !== 200);
    assert.deepEqual(notOk, [], `every save answered 200 (${statuses.length - notOk.length}/${statuses.length})`);
    assert.ok(reader.seen.reads >= MIN_READS, `the reader really ran: ${reader.seen.reads} reads`);
    noTornRead(reader);

    // The last write wins (this loop alternates 1 and 2), and what landed is exactly what the old writer would have
    // written: two-space indent, one trailing newline, and the new key APPENDED after the fixture's own keys in
    // their original order. Read off the FILE, not off a re-serialisation of the panel's memory.
    const expected = { ...before, hideOlderThanDays: ((WRITES - 1) % 2) + 1 };
    assert.equal(readFileSync(configPath, "utf8"), `${JSON.stringify(expected, null, 2)}\n`, "the file's bytes, key order and newline are unchanged");
    assert.deepEqual(
      [...reader.seen.shapes].sort(),
      [Object.keys(before).join(","), Object.keys(expected).join(",")].sort(),
      "every read was one of the two whole documents",
    );

    // ...and the panel reads its own file back, so the settings route serves from the atomic write.
    const config = await (await fetch(`${panel.base}/api/config`)).json();
    assert.equal(config.hideOlderThanDays, expected.hideOlderThanDays);

    // Two saves at the SAME moment: each gets its own temp file, so neither may leave one behind and no reader may
    // see a torn file. Which of the two keys survives is the lost-update race named in the header above — not this
    // test's subject, and not something the atomic replace changes; the file is a whole document either way.
    const together = startReader(configPath);
    const answers = await Promise.all([
      post(panel.base, "/api/settings/age", { body: { days: 21 } }),
      post(panel.base, "/api/settings/collapse-after", { body: { seconds: 45 } }),
    ]);
    await together.stopAndWait();
    assert.deepEqual(answers.map((a) => a.status), [200, 200], "both saves at once answered 200");
    noTornRead(together);
    const shapes = [...together.seen.shapes];
    assert.ok(shapes.length > 0 && shapes.every((s) => s.startsWith(Object.keys(before).join(","))), `every read was a whole document: ${JSON.stringify(shapes)}`);
  } finally {
    await reader.stopAndWait();
    noStrays(configDir);
    await panel.stop();
  }
});
