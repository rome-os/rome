export const CONTAINER_NODE_SOCKET_PATH = "/ws/container-node";

export function isContainerNodeLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(hostname)
  );
}

function isLocalAddress(hostname: string): boolean {
  return (
    isContainerNodeLoopback(hostname) ||
    /^(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^\[f[cd][0-9a-f]{2}:/.test(hostname) ||
    /\.(local|home\.arpa|internal)$/.test(hostname)
  );
}

/** A direct connection can use HTTP on a private address or a local hostname. */
export function containerNodeOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port === "0" ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalAddress(url.hostname)))
  ) {
    throw new Error("Use HTTPS or an HTTP address on a private network.");
  }
  return url.origin;
}
