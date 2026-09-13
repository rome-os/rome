import { describe, expect, it, rs } from "@rstest/core";
import { ComputerUseService } from "./service.js";

const FIRST_SEEN = Date.parse("2026-09-13T09:00:00.000Z");

function fixture() {
  let time = FIRST_SEEN + 10_000;
  let aliases: Record<string, string> = { rome: "rome-id", mac: "mac-id" };
  let fetchWait = Promise.resolve();
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
    await fetchWait;
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body));
  });
  const options = {
    fetch: request as typeof fetch,
    now: () => time,
    readAliases: async () => aliases,
  };
  return {
    settings,
    options,
    request,
    service: new ComputerUseService(settings, options),
    advance: (milliseconds = 60_000) => {
      time += milliseconds;
    },
    respond: (value: unknown) => {
      body = value;
    },
    rename: (value: Record<string, string>) => {
      aliases = value;
    },
    holdRequests: (wait: Promise<void>) => {
      fetchWait = wait;
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
    expect(f.settings.set).toHaveBeenCalledTimes(1);
    const stored = await f.settings.get<Array<{ lastSeenAt: string }>>("computerUse.connections");
    expect(stored?.[0].lastSeenAt).toBe("2026-09-13T09:00:10.000Z");
  });

  it("checkpoints timestamp-only changes every ten minutes despite extra UI probes", async () => {
    const f = fixture();
    await f.service.getStatus();
    for (let tick = 0; tick < 239; tick++) {
      f.advance(2_500);
      await f.service.getStatus();
    }
    expect(f.settings.set).toHaveBeenCalledTimes(1);
    f.advance(2_499);
    await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(1);
    f.advance(1);
    const checkpoint = await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(2);
    expect(await f.settings.get("computerUse.connections")).toEqual(checkpoint.connections);
    f.advance();
    await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(2);
  });

  it("saves status transitions immediately and resets the checkpoint interval", async () => {
    const f = fixture();
    await f.service.getStatus();
    f.advance(9 * 60_000);
    await f.service.getStatus();
    f.respond({ ok: true, profiles: [] });
    const disconnected = await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(2);
    expect(await f.settings.get("computerUse.connections")).toEqual(disconnected.connections);
    f.respond({ ok: true, profiles: [{ contextId: "mac-id", extensionConnected: true }] });
    const reconnected = await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(3);
    expect(await f.settings.get("computerUse.connections")).toEqual(reconnected.connections);
    f.advance();
    await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(3);
    f.advance(9 * 60_000);
    await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(4);
  });

  it("saves renamed and upgraded connections before the next checkpoint", async () => {
    const f = fixture();
    await f.service.getStatus();
    f.advance();
    f.rename({ rome: "rome-id", laptop: "mac-id" });
    const renamed = await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(2);
    expect(await f.settings.get("computerUse.connections")).toEqual(renamed.connections);
    f.respond({
      ok: true,
      profiles: [
        { contextId: "mac-id", extensionConnected: true, extensionVersion: "1.0.25" },
        { contextId: "rome-id", extensionConnected: true, extensionVersion: "1.0.24" },
      ],
    });
    const upgraded = await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(3);
    expect(await f.settings.get("computerUse.connections")).toEqual(upgraded.connections);
  });

  it("retries failed checkpoints without treating them as successful saves", async () => {
    const f = fixture();
    await f.service.getStatus();
    f.advance(10 * 60_000);
    f.settings.set.mockRejectedValueOnce(new Error("database busy"));
    await expect(f.service.getStatus()).rejects.toThrow("database busy");
    f.advance(1_000);
    const retried = await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(3);
    expect(await f.settings.get("computerUse.connections")).toEqual(retried.connections);
    f.advance();
    await f.service.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(3);
  });

  it("flushes the last active probe on shutdown and rejects new probes", async () => {
    const f = fixture();
    await f.service.getStatus();
    f.advance();
    let release!: () => void;
    f.holdRequests(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const probe = f.service.getStatus();
    const stop = f.service.stop();
    await expect(f.service.getStatus()).rejects.toThrow("Computer use service is stopped");
    expect(f.settings.set).toHaveBeenCalledTimes(1);
    release();
    const latest = await probe;
    await stop;
    expect(f.settings.set).toHaveBeenCalledTimes(2);
    expect(await f.settings.get("computerUse.connections")).toEqual(latest.connections);
    await f.service.stop();
    expect(f.settings.set).toHaveBeenCalledTimes(2);
  });

  it("keeps loaded timestamps in memory until the next checkpoint after restart", async () => {
    const f = fixture();
    await f.service.getStatus();
    f.advance();
    const restarted = new ComputerUseService(f.settings, f.options);
    await restarted.getStatus();
    expect(f.settings.set).toHaveBeenCalledTimes(1);
    f.advance(10 * 60_000);
    await restarted.getStatus();
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
