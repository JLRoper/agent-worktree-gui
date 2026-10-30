import { HttpError } from "./errors.js";

// The gateway's complete effort ladder; individual providers may clamp unsupported levels.
export const REASONING_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function normaliseReasoningEffort(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!REASONING_EFFORTS.includes(value)) {
    throw new HttpError(400, `reasoningEffort must be default (empty), ${REASONING_EFFORTS.join(", ")}`);
  }
  return value;
}

export function reasoningModelOptions(value) {
  const effort = normaliseReasoningEffort(value);
  if (effort === null) return null;
  return { reasoning: effort === "none" ? { enabled: false } : { enabled: true, effort } };
}

// Saved jobs load newest-first, while live jobs were inserted oldest-first. Never inherit by Map order.
export function reasoningEffortForTurn(opts, siblings) {
  const latest = [...siblings].sort((a, b) => (Number(b.turn) || 0) - (Number(a.turn) || 0)
    || String(b.startedAt || "").localeCompare(String(a.startedAt || "")))[0];
  return normaliseReasoningEffort(Object.hasOwn(opts, "reasoningEffort") ? opts.reasoningEffort : latest?.reasoningEffort);
}
