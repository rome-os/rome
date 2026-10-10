// Classifies a request as "trusted in-container caller" — an agent-driven
// browser, headless CDP page, or script hitting the loopback listener
// directly. Two signals, both required:
//
// 1. The TCP peer address is a loopback address. This is read from the
//    kernel via the socket (`getpeername`), not from any header — to present
//    a loopback peer address you must complete a TCP handshake from inside
//    this network namespace, which is not forgeable from outside (loopback
//    sources are unroutable and dropped as martian packets at the host).
//
// 2. The request carries no `X-Forwarded-For`. Caddy and Traefik both stamp
//    XFF on every proxied request, and a client can never make the proxy
//    *strip* it — adding the header yourself only moves you out of the
//    trusted set, never into it. This is what separates "Caddy connecting
//    from 127.0.0.1 on behalf of an external user" from a genuine
//    in-container caller.
//
// `isLoopbackAddress` is signal 1; callers such as lib/guardian-session.ts
// check signal 2 themselves.
//
// INVARIANT: every proxy that fronts the Hono listener must set
// `X-Forwarded-For` (Caddy and Traefik do by default). A proxy layer that
// drops it would make external traffic look in-container.

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  // Node reports IPv4-mapped peers as `::ffff:127.0.0.1` on dual-stack sockets.
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (v4 === "::1") return true;
  return v4.startsWith("127.");
}
