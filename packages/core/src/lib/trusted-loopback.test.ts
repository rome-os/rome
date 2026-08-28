import { describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { isLoopbackAddress, isTrustedLoopbackRequest } from "./trusted-loopback.js";

describe("isLoopbackAddress", () => {
  it("accepts the loopback range in every spelling Node reports", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.8.8.8")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects non-loopback and malformed addresses", () => {
    expect(isLoopbackAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("172.18.0.5")).toBe(false);
    expect(isLoopbackAddress("::ffff:172.18.0.5")).toBe(false);
    expect(isLoopbackAddress("1270.0.0.1")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

// Drives the classifier through a real Hono request so it reads the peer
// address exactly the way the node-server bindings expose it (c.env.incoming).
async function probe(headers: Record<string, string>, remoteAddress?: string): Promise<boolean> {
  const app = new Hono();
  let trusted = false;
  app.get("/probe", (c) => {
    trusted = isTrustedLoopbackRequest(c);
    return c.body(null, 204);
  });
  const env = remoteAddress === undefined ? undefined : { incoming: { socket: { remoteAddress } } };
  await app.request("/probe", { headers }, env);
  return trusted;
}

describe("isTrustedLoopbackRequest", () => {
  it("trusts a loopback peer with no X-Forwarded-For", async () => {
    expect(await probe({}, "127.0.0.1")).toBe(true);
    expect(await probe({}, "::1")).toBe(true);
    expect(await probe({}, "::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects proxied requests even when the proxy connects from loopback", async () => {
    // Caddy runs in the same container and connects from 127.0.0.1 — the XFF
    // it stamps on behalf of external users is what must keep them out.
    expect(await probe({ "X-Forwarded-For": "203.0.113.7" }, "127.0.0.1")).toBe(false);
  });

  it("rejects a client-supplied XFF outright (spoofing only de-trusts)", async () => {
    expect(await probe({ "X-Forwarded-For": "127.0.0.1" }, "127.0.0.1")).toBe(false);
  });

  it("rejects non-loopback peers", async () => {
    expect(await probe({}, "172.18.0.5")).toBe(false);
  });

  it("fails closed when connection info is unavailable", async () => {
    expect(await probe({}, undefined)).toBe(false);
  });
});
