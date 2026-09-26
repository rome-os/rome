/**
 * The origin a link can be shared on, or null when this page is served on a
 * loopback host (the Mac app, a local dev stack), whose links open on this
 * machine only.
 */
export function shareableOrigin(location: Pick<Location, "hostname" | "origin"> = window.location) {
  const host = location.hostname;
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host.startsWith("127.");
  return loopback ? null : location.origin;
}
