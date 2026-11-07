/** Whether a listener host is loopback only, so a route may trust that its callers are local. */
export function isLoopbackInternalApiHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}
