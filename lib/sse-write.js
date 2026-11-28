// Writes one SSE frame to one client, with the one bound that keeps a non-reading tab from growing the heap
// forever. `res.write()` never blocks: a peer that stops reading (a laptop asleep, a tab frozen, a half-dead TCP
// connection) leaves every later frame in Node's per-socket write buffer, and a full snapshot here is megabytes.
// Measured 2026-11-28: the panel climbed ~14 MB/min for hours on snapshot pushes; a few MB per push is the whole
// arithmetic. A client already that far behind is not being served — it is dropped, and EventSource reconnects and
// takes a fresh board. The cap is per client, so total buffering is bounded by the connection count.
export const MAX_CLIENT_BUFFER_BYTES = 16 * 1024 * 1024;

export function writeClientFrame(
  res,
  frame,
  { clients = null, metrics = null, maxBufferBytes = MAX_CLIENT_BUFFER_BYTES } = {},
) {
  if (Number(res?.writableLength) > maxBufferBytes) {
    if (metrics) metrics.backpressureDrops = (metrics.backpressureDrops || 0) + 1;
    if (clients) clients.delete(res);
    try {
      res.destroy?.();
    } catch {
      /* already gone */
    }
    return false;
  }
  try {
    res.write(frame);
    return true;
  } catch {
    if (metrics) metrics.writeErrors = (metrics.writeErrors || 0) + 1;
    if (clients) clients.delete(res);
    return false;
  }
}
