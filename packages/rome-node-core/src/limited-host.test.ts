import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { connectLimitedHost } from "./limited-host.js";
import * as cloudModule from "./cloud.js" with { rstest: "importActual" };
import type { GatewayClientOptions } from "./client.js";

const mocks = rs.hoisted(() => ({ config: rs.fn(), connect: rs.fn() }));
rs.mock("./cloud.js", () => ({
  ...cloudModule,
  gatewayConfig: mocks.config,
  cloudRequest: async () => ({ items: [] }),
}));
rs.mock("./client.js", () => ({ connectGateway: mocks.connect }));

const saved = {
  cloudUrl: "https://cloud.example",
  token: `romemob_${"a".repeat(43)}`,
  deviceId: "saved-device",
  name: "Saved computer",
};

let options: GatewayClientOptions;
const connection = { stop: rs.fn(), send: rs.fn(() => true), sendFrame: rs.fn(() => true) };

beforeEach(() => {
  rs.clearAllMocks();
  options = undefined as never;
  mocks.config.mockResolvedValue("wss://gateway.example/connect");
  mocks.connect.mockImplementation((given: GatewayClientOptions) => {
    options = given;
    return connection;
  });
});
afterEach(() => {
  rs.useRealTimers();
});

function run(extra: Partial<Parameters<typeof connectLimitedHost>[0]> = {}) {
  const abort = new AbortController();
  const done = connectLimitedHost({
    cloudUrl: saved.cloudUrl,
    name: "Test",
    signal: abort.signal,
    credentials: {
      load: async () => saved,
      save: async () => undefined,
      clear: async () => undefined,
    },
    authorize: async () => {
      throw new Error("sign in");
    },
    ...extra,
  });
  return { abort, done };
}
const connected = async () => {
  for (let i = 0; i < 20 && !options; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("connectLimitedHost", () => {
  it("connects with the stored device token and refuses requests", async () => {
    const { abort, done } = run();
    await connected();
    expect(options.getToken()).toBe(saved.token);
    options.onMessage({
      id: "r1",
      from: "caller",
      payload: { type: "request", action: "exec", args: { command: "touch", args: ["x"] } },
    });
    expect(connection.send).toHaveBeenCalledWith({
      id: "r1",
      to: "caller",
      payload: {
        type: "response",
        ok: false,
        error: expect.objectContaining({ code: "computer_use_off" }),
      },
    });
    options.onMessage({
      id: "r2",
      from: "caller",
      payload: { type: "request", action: "system.info" },
    });
    expect(connection.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            name: "Saved computer",
            computerUse: false,
            actions: [],
          }),
        }),
      }),
    );
    abort.abort();
    await done;
    expect(connection.stop).toHaveBeenCalled();
  });

  it("passes notifications through and reports the connection", async () => {
    const onNotification = rs.fn();
    const onEvent = rs.fn();
    const host = rs.fn();
    const { abort, done } = run({ onNotification, onEvent, audit: { host } });
    await connected();
    expect(options.onNotification).toBe(onNotification);
    options.onStatus?.("online");
    expect(onEvent).toHaveBeenCalledWith({ type: "connection", status: "online" });
    expect(host).toHaveBeenCalledWith(
      expect.objectContaining({ event: "connection", status: "online" }),
      [saved.token],
    );
    abort.abort();
    await done;
  });

  it("stops with an error when the Gateway revokes the device", async () => {
    const { done } = run();
    await connected();
    options.onStatus?.("revoked");
    await expect(done).rejects.toThrow("revoked");
  });
});
