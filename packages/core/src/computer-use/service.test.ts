import { describe, expect, it, rs } from "@rstest/core";
import { ComputerUseService } from "./service.js";

const FIRST_SEEN = Date.parse("2026-09-13T09:00:00.000Z");

function fixture() {
  let time = FIRST_SEEN + 10_000;
  let body: unknown = {
    ok: true,
    daemonVersion: "1.8.8",
    extensionConnected: false,
    profileRequired: true,
    profiles: [
      {
        contextId: "rome-id",
        extensionConnected: true,
        extensionVersion: "1.0.24",
        lastSeenAt: FIRST_SEEN,
      },
      {
        contextId: "mac-id",
        extensionConnected: true,
        extensionVersion: "1.0.24",
        lastSeenAt: FIRST_SEEN,
      },
    ],
  };
  const values = new Map<string, unknown>();
  const settings = {
    get: async <T = unknown>(key: string): Promise<T | null> => (values.get(key) as T) ?? null,
    set: rs.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
  };
  const request = rs.fn(async () => {
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body));
  });
  const options = {
    fetch: request as typeof fetch,
    now: () => time,
    readAliases: async () => ({ rome: "rome-id", mac: "mac-id" }),
  };
  return {
    settings,
    options,
    request,
    service: new ComputerUseService(settings, options),
    advance: () => {
      time += 60_000;
    },
    respond: (value: unknown) => {
      body = value;
    },
  };
}

describe("ComputerUseService", () => {
  it("lists every connected profile even when the daemon requires a selection", async () => {
    const { service } = fixture();
    const status = await service.getStatus();
    expect(status.daemon).toEqual({ status: "running", version: "1.8.8" });
    expect(status.connections.map(({ id, name, status }) => ({ id, name, status }))).toEqual([
      { id: "mac-id", name: "mac", status: "connected" },
      { id: "rome-id", name: "rome", status: "connected" },
    ]);
  });

  it("records confirmed presence without relying on OpenCLI's handshake timestamp", async () => {
    const f = fixture();
    await f.service.getStatus();
    await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(1);
    f.advance();
    const status = await f.service.getStatus();
    expect(status.connections[0].lastSeenAt).toBe("2026-09-13T09:01:10.000Z");
    expect(status.checkedAt).toBe("2026-09-13T09:01:10.000Z");
    expect(f.settings.set).toHaveBeenCalledTimes(2);
  });

  it("retains disconnected profiles and last seen across Rome restarts", async () => {
    const f = fixture();
    await f.service.getStatus();
    f.respond({ ok: true, daemonVersion: "1.8.8", profiles: [] });
    f.advance();
    const restarted = new ComputerUseService(f.settings, f.options);
    const status = await restarted.getStatus();
    expect(status.connections).toHaveLength(2);
    expect(status.connections.every((c) => c.status === "disconnected")).toBe(true);
    expect(status.connections[0].lastSeenAt).toBe("2026-09-13T09:00:10.000Z");
  });

  it("reports unknown status when the daemon cannot be reached or returns malformed data", async () => {
    const f = fixture();
    await f.service.getStatus();
    for (const response of [new Error("offline"), { ok: true, profiles: "invalid" }]) {
      f.respond(response);
      const status = await f.service.getStatus();
      expect(status.daemon.status).toBe("unavailable");
      expect(status.connections[0]).toMatchObject({
        status: "unknown",
        lastSeenAt: "2026-09-13T09:00:10.000Z",
      });
    }
  });

  it("reuses a profile after reconnection and advances only its last seen time", async () => {
    const f = fixture();
    await f.service.getStatus();
    f.respond({ ok: true, profiles: [] });
    await f.service.getStatus();
    f.advance();
    f.respond({
      ok: true,
      profiles: [
        { contextId: "mac-id", extensionConnected: true, lastSeenAt: FIRST_SEEN + 60_000 },
      ],
    });
    const status = await f.service.getStatus();
    expect(status.connections).toHaveLength(2);
    expect(status.connections[0]).toMatchObject({
      status: "connected",
      lastSeenAt: "2026-09-13T09:01:10.000Z",
    });
    expect(status.connections[1].status).toBe("disconnected");
    expect(status.connections[1].lastSeenAt).toBe("2026-09-13T09:00:10.000Z");
  });

  it("coalesces concurrent probes and records presence without an upstream timestamp", async () => {
    const f = fixture();
    f.respond({ ok: true, profiles: [{ contextId: "mac-id", extensionConnected: true }] });
    const [first, second] = await Promise.all([f.service.getStatus(), f.service.getStatus()]);
    expect(first).toBe(second);
    expect(first.connections[0].lastSeenAt).toBe("2026-09-13T09:00:10.000Z");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
