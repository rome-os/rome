/** System errors that mean the connection to a platform was never made. A reset
 *  or a timeout is not among them, since it can follow a request already sent. */
const NEVER_CONNECTED = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

/** Whether the error, or a cause it wraps, is a failure to connect, so the
 *  request it carried never arrived. */
export function neverConnected(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 3 && cause && typeof cause === "object"; depth++) {
    const { code, cause: inner } = cause as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && NEVER_CONNECTED.has(code)) return true;
    cause = inner;
  }
  return false;
}
