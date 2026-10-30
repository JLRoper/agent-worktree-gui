// The status a failed request should answer with.
//
// A handler that rejects its caller on purpose throws HttpError and names the status. Anything else
// that escapes a handler is a fault in this process, and a fault is a 500: the outer catch used to
// answer 400 for everything, which made every internal error look like the caller's mistake and left
// nothing in the log to explain it. That is the difference this module encodes.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = Number.isInteger(status) ? status : 500;
  }
}

// Only an HttpError carries a status the caller chose. A stray `.status` on a random error object is
// not trusted: an internal fault must never be able to dress itself up as a 4xx by accident.
export function errorStatus(e) {
  return e instanceof HttpError ? e.status : 500;
}
