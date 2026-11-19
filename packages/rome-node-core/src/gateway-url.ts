import { containerNodeOrigin, CONTAINER_NODE_SOCKET_PATH } from "./container-node-address.js";

export function parseGatewayUrl(value: string, directHttpOrigin?: string): URL {
  const url = new URL(value);
  if (directHttpOrigin) {
    const origin = containerNodeOrigin(directHttpOrigin);
    if (
      origin.startsWith("http:") &&
      url.href === `${origin.replace(/^http:/, "ws:")}${CONTAINER_NODE_SOCKET_PATH}`
    ) {
      return url;
    }
    throw new Error("Use the direct Gateway on the container's configured Rome address.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "wss:" &&
      !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Use a credential-free WSS URL. WS is allowed only on loopback.");
  return url;
}
