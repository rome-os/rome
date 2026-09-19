import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { connectComputer } from "./connect.js";
import { CloudError } from "./cloud.js";
import * as cloudModule from "./cloud.js" with { rstest: "importActual" };
import type { GatewayClientOptions } from "./client.js";

const mocks = rs.hoisted(() => ({
  read: rs.fn(),
  write: rs.fn(),
  login: rs.fn(),
  config: rs.fn(),
  remove: rs.fn(),
  connect: rs.fn(),
}));
rs.mock("./storage.js", () => ({ readPrivateJson: mocks.read, writePrivateJson: mocks.write }));
rs.mock("./login.js", () => ({ loginDevice: mocks.login }));
rs.mock("node:fs/promises", () => ({ rm: mocks.remove }));
rs.mock("./cloud.js", () => ({
  ...cloudModule,
  gatewayConfig: mocks.config,
  cloudRequest: async () => ({ items: [] }),
}));
rs.mock("./client.js", () => ({ connectGateway: mocks.connect }));

const saved = {
  cloudUrl: "https://cloud.example",
  token: `romedev_${"a".repeat(43)}`,
  deviceId: "saved-device",
  name: "Saved computer",
};
beforeEach(() => {
  rs.clearAllMocks();
  rs.useFakeTimers();
  mocks.read.mockResolvedValue(saved);
  mocks.write.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.login.mockResolvedValue({ ...saved, deviceId: "new-device" });
  mocks.config.mockResolvedValue("wss://gateway.example/connect");
  mocks.connect.mockImplementation((options: GatewayClientOptions) => {
    queueMicrotask(() => options.onStatus?.("superseded"));
    return { stop: rs.fn(), send: rs.fn() };
  });
});
afterEach(() => {
  rs.useRealTimers();
});

describe("executor credential lifecycle", () => {
  it("reuses a valid stored identity without browser authorization", async () => {
    await expect(
      connectComputer(saved.cloudUrl, "Test", new AbortController().signal),
    ).rejects.toThrow("replaced");
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.connect.mock.calls[0][0].deviceToken).toBe(saved.token);
  });
  it.each([
    null,
    { token: "malformed" },
  ])("authorizes missing or malformed credentials", async (stored) => {
    mocks.read.mockResolvedValue(stored);
    await expect(
      connectComputer(saved.cloudUrl, "Test", new AbortController().signal),
    ).rejects.toThrow("replaced");
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it("reauthorizes only confirmed-invalid credentials on explicit startup", async () => {
    mocks.config.mockRejectedValueOnce(new CloudError("invalid_device_session"));
    await expect(
      connectComputer(saved.cloudUrl, "Test", new AbortController().signal),
    ).rejects.toThrow("replaced");
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.login).toHaveBeenCalledTimes(1);
  });
  it("preserves credentials during temporary failure and cancels retry on shutdown", async () => {
    rs.useRealTimers();
    mocks.config.mockRejectedValue(new CloudError("cloud_unavailable"));
    const controller = new AbortController();
    const running = connectComputer(saved.cloudUrl, "Test", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    controller.abort();
    await running;
    expect(mocks.config.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("stops on runtime invalidation and preserves temporary config errors", async () => {
    await expect(
      connectComputer(saved.cloudUrl, "Test", new AbortController().signal),
    ).rejects.toThrow("replaced");
    const options: GatewayClientOptions = mocks.connect.mock.calls[0][0];
    mocks.config.mockRejectedValueOnce(new CloudError("cloud_unavailable"));
    await expect(options.beforeConnect!()).rejects.toThrow("unavailable");
    mocks.config.mockRejectedValueOnce(new CloudError("invalid_device_session"));
    expect(await options.beforeConnect!()).toBeNull();
    expect(mocks.login).not.toHaveBeenCalled();
  });
});
