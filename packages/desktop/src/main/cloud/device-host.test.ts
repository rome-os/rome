import { describe, expect, it, rs } from "@rstest/core";

rs.mock("../logger", () => ({
  createLogger: () => ({ error: rs.fn(), info: rs.fn(), warn: rs.fn() }),
}));

import type { HostEvent, HostOptions } from "@rome-os/node-core/host";
import { DeviceHost, type DeviceHostOptions, type DeviceStatus } from "./device-host";

const credential = {
  accessToken: `romemob_${"a".repeat(43)}`,
  deviceSessionId: "0f8e2a9c-6b1d-4c3e-9a7f-2d5b8c1e4f60",
};

/** A Gateway connection the test drives: events go in, and it ends when told. */
function fakeGateway() {
  const calls: HostOptions[] = [];
  let end: (error?: Error) => void = () => undefined;
  const connect = rs.fn(
    (options: HostOptions) =>
      new Promise<void>((resolve, reject) => {
        calls.push(options);
        end = (error) => (error ? reject(error) : resolve());
        options.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  return {
    connect,
    calls,
    emit: (event: HostEvent) => calls.at(-1)?.onEvent?.(event),
    end: (error?: Error) => end(error),
  };
}

function host(overrides: Partial<DeviceHostOptions> = {}) {
  const gateway = fakeGateway();
  const statuses: DeviceStatus[] = [];
  const options: DeviceHostOptions = {
    cloudOrigin: "https://romeos.cc",
    deviceName: "RayBook",
    credential: async () => credential,
    enabled: () => true,
    onRevoked: rs.fn(async () => undefined),
    prepare: rs.fn(async () => undefined),
    onStatus: (status) => statuses.push(status),
    connect: gateway.connect,
    ...overrides,
  };
  return { subject: new DeviceHost(options), options, gateway, statuses };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DeviceHost", () => {
  it("stays off without a Rome Cloud sign-in", async () => {
    const { subject, gateway, options } = host({ credential: async () => null });
    subject.start();
    await settle();
    expect(gateway.connect).not.toHaveBeenCalled();
    expect(options.prepare).not.toHaveBeenCalled();
    expect(subject.status()).toEqual({ state: "off" });
  });

  it("stays disconnected while the user has turned the device off", async () => {
    const { subject, gateway, options } = host({ enabled: () => false });
    subject.start();
    await settle();
    expect(gateway.connect).not.toHaveBeenCalled();
    expect(options.prepare).not.toHaveBeenCalled();
    expect(subject.status()).toEqual({
      state: "disabled",
      deviceId: credential.deviceSessionId,
      name: "RayBook",
    });
  });

  it("connects as the device the app signed in as, once", async () => {
    const { subject, gateway } = host();
    subject.start();
    subject.start();
    await settle();
    expect(gateway.connect).toHaveBeenCalledTimes(1);
    const stored = await gateway.calls[0].credentials.load();
    expect(stored).toEqual({
      cloudUrl: "https://romeos.cc",
      token: credential.accessToken,
      deviceId: credential.deviceSessionId,
      name: "RayBook",
    });
  });

  it("reports the name Rome Cloud gives the device once online", async () => {
    const { subject, gateway, statuses } = host();
    subject.start();
    await settle();
    gateway.emit({ type: "device", name: "Ray's MacBook", deviceId: credential.deviceSessionId });
    gateway.emit({ type: "connection", status: "online" });
    expect(subject.status()).toEqual({
      state: "connected",
      deviceId: credential.deviceSessionId,
      name: "Ray's MacBook",
    });
    gateway.emit({ type: "connection", status: "retrying" });
    expect(statuses.map((status) => status.state)).toEqual(["connecting", "connected", "offline"]);
  });

  it("never opens a second browser sign-in", async () => {
    const { subject, gateway } = host();
    subject.start();
    await settle();
    await expect(
      gateway.calls[0].authorize("https://romeos.cc", "RayBook", new AbortController().signal),
    ).rejects.toThrow("Sign in to Rome Cloud");
  });

  it("disconnects on stop without signing the app out", async () => {
    const { subject, gateway, options } = host();
    subject.start();
    await settle();
    await subject.stop();
    expect(gateway.calls[0].signal.aborted).toBe(true);
    expect(subject.status()).toEqual({ state: "off" });
    expect(options.onRevoked).not.toHaveBeenCalled();
  });

  it("signs the app out when Rome Cloud revokes the device", async () => {
    const { subject, gateway, options } = host();
    subject.start();
    await settle();
    gateway.emit({ type: "connection", status: "revoked" });
    // The host then stops the connection, which reports "stopped" before it ends.
    gateway.emit({ type: "connection", status: "stopped" });
    gateway.end(new Error("Authorization revoked. Explicit authorization is required."));
    await settle();
    expect(options.onRevoked).toHaveBeenCalledTimes(1);
    expect(subject.status()).toEqual({ state: "off" });
  });

  it("signs the app out when Rome Cloud rejects the stored sign-in", async () => {
    // connectHost asks authorize() for a new identity, and rejects with its error.
    const connect = rs.fn(async (options: HostOptions) => {
      await options.authorize(options.cloudUrl, options.name, options.signal);
    });
    const { subject, options } = host({ connect });
    subject.start();
    await settle();
    expect(options.onRevoked).toHaveBeenCalledTimes(1);
    expect(subject.status()).toEqual({ state: "off" });
  });

  it("keeps the sign-in when another connection replaces this one", async () => {
    const { subject, gateway, options } = host();
    subject.start();
    await settle();
    gateway.emit({ type: "connection", status: "superseded" });
    gateway.end(new Error("Another connection replaced this device. This process has stopped."));
    await settle();
    expect(options.onRevoked).not.toHaveBeenCalled();
    expect(subject.status()).toEqual({
      state: "offline",
      deviceId: credential.deviceSessionId,
      name: "RayBook",
    });
  });

  it("resolves start once the status says whether it connects", async () => {
    let enabled = false;
    const { subject } = host({ enabled: () => enabled });
    await subject.start();
    expect(subject.status().state).toBe("disabled");
    await subject.stop();
    enabled = true;
    await subject.start();
    expect(subject.status().state).toBe("connecting");
  });

  it("goes straight to off when stopped on purpose", async () => {
    const { subject, gateway, statuses } = host();
    await subject.start();
    gateway.emit({ type: "connection", status: "online" });
    statuses.length = 0;
    const stopping = subject.stop();
    // The host reports "stopped" as it closes the connection.
    gateway.emit({ type: "connection", status: "stopped" });
    await stopping;
    expect(statuses.map((status) => status.state)).toEqual(["off"]);
  });

  it("prepares the computer once across reconnects", async () => {
    const { subject, gateway, options } = host();
    subject.start();
    await settle();
    await subject.stop();
    subject.start();
    await settle();
    expect(gateway.connect).toHaveBeenCalledTimes(2);
    expect(options.prepare).toHaveBeenCalledTimes(1);
  });
});
