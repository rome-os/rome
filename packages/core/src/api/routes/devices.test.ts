import { describe, expect, it, rs } from "@rstest/core";
import { devicesRoutes } from "./devices.js";
import { createNodeDevicesService } from "../../lib/node-devices.js";
import { CallerConfigurationError, DaemonVersionError } from "@rome-os/node-core/client";

it("returns device checks without credentials or caching at the HTTP edge", async () => {
  const nodeDevices = createNodeDevicesService(() => ({
    disconnect() {},
    run: rs.fn(),
    getDevicesStatus: async () => ({
      connection: "online",
      checkedAt: new Date().toISOString(),
      devices: [
        { id: "mac", name: "Mac", platform: "macos", status: "connected", token: "secret" },
      ],
      token: "secret",
    }),
  }));
  const response = await devicesRoutes({ nodeDevices }).request("/devices");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).toContain('"connected"');
  expect(body).not.toContain("secret");
  nodeDevices.close();
});

describe("device status failures", () => {
  it("reports a missing daemon without fabricating an empty connected-device count", async () => {
    const service = createNodeDevicesService(() => ({
      disconnect() {},
      run: rs.fn(),
      getDevicesStatus: async () => null,
    }));
    const response = await devicesRoutes({ nodeDevices: service }).request("/devices");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connection: "not_running", devices: [] });
    service.close();
  });

  it.each([
    [new CallerConfigurationError("not_configured", "secret"), "not_configured"],
    [new DaemonVersionError(), "incompatible"],
    [new Error("private credential path"), "unavailable"],
  ] as const)("reports unavailable counts safely (%s)", async (error, connection) => {
    const nodeDevices = createNodeDevicesService(() => ({
      disconnect() {},
      run: rs.fn(),
      getDevicesStatus: async () => {
        throw error;
      },
    }));
    expect(await nodeDevices.getStatus()).toMatchObject({ connection, devices: [] });
    nodeDevices.close();
  });

  it("recreates an incompatible client so refresh can see the restarted daemon", async () => {
    const disconnect = rs.fn();
    const getDevicesStatus = rs
      .fn()
      .mockRejectedValueOnce(new DaemonVersionError())
      .mockResolvedValue({
        connection: "stopped",
        checkedAt: new Date().toISOString(),
        devices: [],
      });
    const createClient = rs.fn(() => ({ disconnect, getDevicesStatus, run: rs.fn() }));
    const service = createNodeDevicesService(createClient);
    expect((await service.getStatus()).connection).toBe("incompatible");
    expect((await service.getStatus()).connection).toBe("stopped");
    expect(createClient).toHaveBeenCalledTimes(2);
    service.close();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});

describe("explicit device service startup", () => {
  it("starts only on POST and leaves status reads passive", async () => {
    const start = rs.fn(async () => {});
    const getDevicesStatus = rs.fn(async () => null);
    const service = createNodeDevicesService(
      () => ({ disconnect() {}, run: rs.fn(), getDevicesStatus }),
      start,
    );
    const app = devicesRoutes({ nodeDevices: service });
    await app.request("/devices");
    await app.request("/devices");
    expect(start).not.toHaveBeenCalled();
    expect((await app.request("/devices/start")).status).toBe(404);
    expect(start).not.toHaveBeenCalled();
    const response = await app.request("/devices/start", { method: "POST" });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(start).toHaveBeenCalledTimes(1);
    expect(getDevicesStatus).toHaveBeenCalledTimes(2);
    service.close();
  });

  it.each([
    [new CallerConfigurationError("not_configured", "private credential"), 409, "not_configured"],
    [new DaemonVersionError(), 409, "incompatible"],
    [new Error("private credential path"), 503, "start_failed"],
  ] as const)("sanitizes startup failures without retrying (%s)", async (error, status, code) => {
    const start = rs.fn(async () => {
      throw error;
    });
    const service = createNodeDevicesService(
      () => ({ disconnect() {}, run: rs.fn(), getDevicesStatus: async () => null }),
      start,
    );
    const response = await devicesRoutes({ nodeDevices: service }).request("/devices/start", {
      method: "POST",
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(start).toHaveBeenCalledTimes(1);
    service.close();
  });
});

describe("device folder listing", () => {
  const folder = {
    path: "/Users/ray/code",
    parent: "/Users/ray",
    entries: [{ name: "rome", type: "dir" }],
    truncated: false,
  };

  it("runs fs.list with the path and returns the folder uncached", async () => {
    const run = rs.fn(async () => ({
      type: "response" as const,
      ok: true as const,
      result: folder,
    }));
    const service = createNodeDevicesService(() => ({
      disconnect() {},
      getDevicesStatus: async () => null,
      run,
    }));
    const app = devicesRoutes({ nodeDevices: service });
    const response = await app.request("/devices/mac/files?path=%2FUsers%2Fray%2Fcode");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(folder);
    expect(run).toHaveBeenCalledWith("mac", "fs.list", { path: "/Users/ray/code" });
    await app.request("/devices/mac/files");
    expect(run).toHaveBeenLastCalledWith("mac", "fs.list", {});
    service.close();
  });

  it.each([
    ["unsupported_action", 409, "upgrade_required"],
    ["target_unavailable", 503, "offline"],
    ["not_found", 404, "not_found"],
    ["not_a_directory", 400, "not_a_directory"],
    ["permission_denied", 403, "permission_denied"],
    ["unknown_outcome", 503, "unavailable"],
  ] as const)("maps the device error %s", async (code, status, error) => {
    const service = createNodeDevicesService(() => ({
      disconnect() {},
      getDevicesStatus: async () => null,
      run: async () => ({
        type: "response" as const,
        ok: false as const,
        error: { code, message: "private detail" },
      }),
    }));
    const response = await devicesRoutes({ nodeDevices: service }).request("/devices/mac/files");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    service.close();
  });

  it("reports a malformed reply or a client failure as unavailable", async () => {
    const malformed = createNodeDevicesService(() => ({
      disconnect() {},
      getDevicesStatus: async () => null,
      run: async () => ({ type: "response" as const, ok: true as const, result: { path: 1 } }),
    }));
    expect(await malformed.listFiles("mac")).toEqual({ ok: false, code: "unavailable" });
    malformed.close();
    const failing = createNodeDevicesService(() => ({
      disconnect() {},
      getDevicesStatus: async () => null,
      run: async () => {
        throw new CallerConfigurationError("not_configured", "secret");
      },
    }));
    expect(await failing.listFiles("mac")).toEqual({ ok: false, code: "unavailable" });
    failing.close();
  });
});
