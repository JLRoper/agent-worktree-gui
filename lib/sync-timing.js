// Measure actual synchronous work rather than inferring blame from an overlapping async activity
// label. The wrapper preserves the wrapped function's return value and exceptions, and retains
// only bounded, static phase names and durations (never request bodies, paths or credentials).
import { performance } from "node:perf_hooks";
import { logger } from "./log.js";

export function createSyncTiming({ thresholdMs = 250, limit = 20, now = () => performance.now(),
  wallNow = () => Date.now(), warn = (...args) => logger.warn(...args) } = {}) {
  const threshold = Math.max(1, Number(thresholdMs) || 250);
  const cap = Math.max(1, Math.floor(Number(limit) || 20));
  const recent = [];
  let count = 0;
  let maxMs = 0;
  return {
    measure(phase, fn) {
      const started = now();
      try {
        return fn();
      } finally {
        const ms = Math.max(0, now() - started);
        if (ms >= threshold) {
          const entry = { phase: String(phase), ms: Math.round(ms), at: new Date(wallNow()).toISOString() };
          count += 1;
          maxMs = Math.max(maxMs, entry.ms);
          recent.push(entry);
          if (recent.length > cap) recent.shift();
          try { warn(`slow synchronous phase: ${entry.phase} took ${entry.ms}ms`); } catch { /* diagnostics must not break the request */ }
        }
      }
    },
    stats() {
      return { thresholdMs: threshold, count, maxMs, recent: recent.map((entry) => ({ ...entry })) };
    },
  };
}

export const syncTiming = createSyncTiming();
