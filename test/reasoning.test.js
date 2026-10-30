import assert from "node:assert/strict";
import test from "node:test";
import { REASONING_EFFORTS, normaliseReasoningEffort, reasoningEffortForTurn, reasoningModelOptions } from "../lib/reasoning.js";
import { previewRequest } from "../lib/hermes-runtime.js";
import { errorStatus } from "../lib/errors.js";

test("every offered effort maps to the gateway contract, while default omits the override", () => {
  for (const effort of REASONING_EFFORTS) {
    assert.equal(normaliseReasoningEffort(effort), effort);
    assert.deepEqual(reasoningModelOptions(effort), { reasoning: effort === "none" ? { enabled: false } : { enabled: true, effort } });
    assert.deepEqual(previewRequest({ prompt: "task", reasoningEffort: effort }).body.model_options, reasoningModelOptions(effort));
  }
  for (const value of [undefined, null, ""]) {
    assert.equal(normaliseReasoningEffort(value), null);
    assert.equal(reasoningModelOptions(value), null);
    assert.equal(Object.hasOwn(previewRequest({ reasoningEffort: value }).body, "model_options"), false);
  }
});

test("unknown reasoning values are a caller error rather than a silently ignored request", () => {
  for (const value of ["turbo", "MEDIUM", " medium ", {}, [], true, 1]) {
    assert.throws(() => reasoningModelOptions(value), (error) => errorStatus(error) === 400 && /reasoningEffort/.test(error.message));
  }
});

test("continuations inherit the newest turn in either live or restored store order", () => {
  const older = { turn: 1, reasoningEffort: "high" };
  const newer = { turn: 2, reasoningEffort: "medium" };
  assert.equal(reasoningEffortForTurn({}, [older, newer]), "medium");
  assert.equal(reasoningEffortForTurn({}, [newer, older]), "medium");
  assert.equal(reasoningEffortForTurn({ reasoningEffort: "low" }, [newer, older]), "low");
  assert.equal(reasoningEffortForTurn({ reasoningEffort: "" }, [newer, older]), null);
  assert.equal(reasoningEffortForTurn({ reasoningEffort: null }, [newer, older]), null);
  assert.equal(reasoningEffortForTurn({}, [{ turn: 1 }]), null, "old stores keep the old default behavior");
});
