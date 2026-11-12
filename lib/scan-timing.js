// Queue wait and scan-phase timing, recorded per scan.
//
// Two numbers the panel could not answer during the "why is the board slow" investigation:
//   * queueWaitMs - how long a scan sat in the pending queue before a worker took it;
//   * scanMs      - how long the worker held it (the git phase).
//
// Both are pure accumulators over an injectable clock so tests can drive them with
// synthetic timestamps (no live service, no private stores). Nothing here touches
// a worker or the store: the pool records the two instants and hands them here.

export function createScanTiming({ now = () => Date.now(), recentSize = 25 } = {}) {
  const wait = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
  const scan = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
  const recent = [];
  const keep = Math.max(1, Math.floor(recentSize) || 25);

  function record(bucket, ms) {
    const value = Math.max(0, Math.round(ms) || 0);
    bucket.count += 1;
    bucket.totalMs += value;
    bucket.maxMs = Math.max(bucket.maxMs, value);
    bucket.lastMs = value;
  }

  return {
    recordWait(ms) {
      record(wait, ms);
    },
    recordScan(startedAt, { depth = "fast", project = "", waitedMs = 0 } = {}) {
      record(scan, now() - startedAt);
      recent.push({
        at: new Date(now()).toISOString(),
        project,
        depth,
        waitedMs: Math.max(0, Math.round(waitedMs) || 0),
        ms: scan.lastMs,
      });
      if (recent.length > keep) recent.shift();
    },
    stats() {
      const avg = (b) => (b.count ? Math.round(b.totalMs / b.count) : 0);
      return {
        queueWait: { count: wait.count, lastMs: wait.lastMs, maxMs: wait.maxMs, avgMs: avg(wait) },
        scanPhase: { count: scan.count, lastMs: scan.lastMs, maxMs: scan.maxMs, avgMs: avg(scan) },
        recent: recent.map((entry) => ({ ...entry })),
      };
    },
  };
}
