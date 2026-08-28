import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { Hono } from "hono";
import {
  capabilityDiscoveryRoutes,
  type CapabilityDiscoverySource,
} from "./capability-discovery.js";

/** A source that reaches nothing, so a test opts in to each host fact it depends on. */
function stubSource(overrides: Partial<CapabilityDiscoverySource> = {}): CapabilityDiscoverySource {
  return {
    tailscaleStatus: () => Promise.reject(new Error("tailscale: command not found")),
    peerManifest: () => Promise.reject(new Error("ECONNREFUSED")),
    ...overrides,
  };
}

function tailscaleStatusJson(
  peers: Array<{ hostname: string; ip: string; online?: boolean }>,
): string {
  return JSON.stringify({
    Peer: Object.fromEntries(
      peers.map((p) => [
        `key-${p.hostname}`,
        {
          HostName: p.hostname,
          DNSName: `${p.hostname}.example.ts.net`,
          TailscaleIPs: [p.ip],
          OS: "macOS",
          Online: p.online ?? true,
        },
      ]),
    ),
  });
}

const EMPTY_PAYLOAD = { peers: [], desktopDetected: false, cdpRunning: false };

describe("Capability-discovery API", () => {
  let app: Hono;
  let fetchSpy: ReturnType<typeof rs.fn>;

  beforeEach(() => {
    app = new Hono().route("/", capabilityDiscoveryRoutes(stubSource()));
    fetchSpy = rs.spyOn(globalThis, "fetch") as unknown as ReturnType<typeof rs.fn>;
  });

  afterEach(() => {
    rs.restoreAllMocks();
  });

  describe("GET /capability-discovery", () => {
    it("returns an empty payload when tailscale is unavailable", async () => {
      const res = await app.request("/capability-discovery");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(EMPTY_PAYLOAD);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("returns an empty payload when tailscale reports no peers", async () => {
      const source = stubSource({ tailscaleStatus: async () => JSON.stringify({}) });
      const res = await new Hono()
        .route("/", capabilityDiscoveryRoutes(source))
        .request("/capability-discovery");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(EMPTY_PAYLOAD);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("reports the desktop and its CDP server from a peer manifest", async () => {
      const source = stubSource({
        tailscaleStatus: async () =>
          tailscaleStatusJson([{ hostname: "studio", ip: "100.64.0.1" }]),
        peerManifest: async () => ({
          name: "rome-desktop",
          capabilities: { cdp_servers: [{ name: "Chrome", port: 9222, status: "running" }] },
        }),
      });
      const res = await new Hono()
        .route("/", capabilityDiscoveryRoutes(source))
        .request("/capability-discovery");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        peers: [
          {
            hostname: "studio",
            ip: "100.64.0.1",
            name: "rome-desktop",
            capabilities: { cdp_servers: [{ name: "Chrome", port: 9222, status: "running" }] },
          },
        ],
        desktopDetected: true,
        cdpRunning: true,
      });
    });

    it("skips offline and unreachable peers, and keeps peers that answer non-OK", async () => {
      const source = stubSource({
        tailscaleStatus: async () =>
          tailscaleStatusJson([
            { hostname: "offline-box", ip: "100.64.0.1", online: false },
            { hostname: "unreachable", ip: "100.64.0.2" },
            { hostname: "no-manifest", ip: "100.64.0.3" },
          ]),
        peerManifest: async (ip) => {
          if (ip === "100.64.0.2") throw new Error("ECONNREFUSED");
          return null;
        },
      });
      const res = await new Hono()
        .route("/", capabilityDiscoveryRoutes(source))
        .request("/capability-discovery");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        peers: [{ hostname: "no-manifest", ip: "100.64.0.3", name: null, capabilities: null }],
        desktopDetected: false,
        cdpRunning: false,
      });
    });

    it("reports the desktop without CDP when no server is running", async () => {
      const source = stubSource({
        tailscaleStatus: async () =>
          tailscaleStatusJson([{ hostname: "studio", ip: "100.64.0.1" }]),
        peerManifest: async () => ({
          name: "rome-desktop",
          capabilities: { cdp_servers: [{ name: "Chrome", port: 9222, status: "stopped" }] },
        }),
      });
      const res = await new Hono()
        .route("/", capabilityDiscoveryRoutes(source))
        .request("/capability-discovery");
      const body = (await res.json()) as { desktopDetected: boolean; cdpRunning: boolean };
      expect(body.desktopDetected).toBe(true);
      expect(body.cdpRunning).toBe(false);
    });
  });

  describe("POST /capability-discovery/open-page", () => {
    const validBody = { ip: "10.0.0.10", cdpPort: 9222, url: "https://example.com" };

    it("returns 400 for missing fields", async () => {
      const res = await app.request("/capability-discovery/open-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: "10.0.0.10" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for non-numeric cdpPort", async () => {
      const res = await app.request("/capability-discovery/open-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, cdpPort: "9222" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when the body is not valid JSON", async () => {
      const res = await app.request("/capability-discovery/open-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("retries GET when PUT returns 405 and returns success on 2xx", async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response(null, { status: 405 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      const res = await app.request("/capability-discovery/open-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("returns 502 when CDP returns a non-OK status", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }));
      const res = await app.request("/capability-discovery/open-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("500");
    });

    it("returns 500 when the CDP fetch throws", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const res = await app.request("/capability-discovery/open-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(500);
    });
  });
});
