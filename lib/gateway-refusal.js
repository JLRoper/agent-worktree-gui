// What a failed gateway probe MEANS, in one sentence, in one place.
//
// `GET /v1/capabilities` is the panel's cheapest question ("can this box run anything right now?"),
// and its three failures are not the same fact:
//
//   * no answer inside the budget - the probe TIMED OUT. Nothing was learned about the gateway.
//   * an answer that is not OK   - the gateway REFUSED, and its status code is the reason.
//   * no connection at all       - a transport error (ECONNREFUSED, DNS, TLS).
//
// Only the last two say the gateway is unusable. Measured on this board (2026-11-06): a spawn was
// refused with "the Hermes gateway API is not usable" while /v1/capabilities answered 200 in 4-14 ms
// from the same host and /api/state read `reachable: true` - the 4-second abort had been reported as a
// verdict on the gateway. A timeout is worded as the probe's own deadline so a reader can tell the two
// apart, and `Jobs.probe()` retries that one case before it is reported at all.
//
// The refusal sentence is keyed on what the probe actually got: the status code when there was one,
// the transport error when there was no answer at all.
export function gatewayRefusalText(transport, url) {
  const at = url || transport?.url || "the gateway";
  const ms = Number(transport?.timeoutMs) || 4000;
  const budget = ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
  if (transport?.timedOut) {
    return `the gateway probe timed out at ${at}: /v1/capabilities gave no answer within ${budget} on either of two attempts - a slow probe, not a gateway that refused, and the Runs API stays unconfirmed so no spawn is sent`;
  }
  if (Number(transport?.status) > 0) {
    return `the Hermes gateway API is not usable at ${at}: /v1/capabilities answered HTTP ${transport.status}`;
  }
  const why = String(transport?.error || "").trim();
  return `the Hermes gateway API is not usable at ${at}${why ? `: ${why}` : ""}`;
}
