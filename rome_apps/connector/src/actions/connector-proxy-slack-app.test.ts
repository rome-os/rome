import type { ActionConfig, AppActionRuntimeDeps, ChannelsService } from "@rome-os/app-runtime";
import { describe, expect, it, rs } from "@rstest/core";

// connector_proxy answers Slack through Rome's own Slack app connection: the
// channels service, never a token.
const { createAction } = await import("./connector-proxy/index.js");

const config: ActionConfig = {
  name: "connector_proxy",
  type: "custom",
  description: "connector_proxy",
  complexity: "simple",
  speed: "moderate",
  reliability: "medium",
  sideEffects: "write",
};

const APP = { platform: "slack", id: "T1/B1" };

function run(channelsService: ChannelsService | undefined, input: Record<string, unknown>) {
  const deps = { appContext: { db: {} }, channelsService } as unknown as AppActionRuntimeDeps;
  return createAction(config, deps).execute(input);
}

describe("connector_proxy for Slack through Rome's Slack app", () => {
  it("sends through the Slack app connection", async () => {
    const send = rs.fn(async () => ({ chatId: "D1", messageId: "1700000000.000200" }));
    const service = {
      list: async () => [{ name: "slack_app", account: APP, platform: "slack", sendable: true }],
      send,
      query: rs.fn(),
    } as unknown as ChannelsService;

    const result = await run(service, {
      toolkit: "slack",
      path: "/api/chat.postMessage",
      method: "POST",
      body: { channel: "D1", text: "hi" },
    });

    expect(send).toHaveBeenCalledWith(APP, "D1", { text: "hi" });
    expect(result).toMatchObject({
      status: "ok",
      data: { data: { ok: true, ts: "1700000000.000200" } },
    });
  });

  it("reads parameters from the path's query string, letting query win a clash", async () => {
    const send = rs.fn(async () => ({ chatId: "C1:1700000000.000100", messageId: "1.2" }));
    const queried = rs.fn(async () => []);
    const service = {
      list: async () => [{ name: "slack_app", account: APP, platform: "slack", sendable: true }],
      send,
      query: queried,
    } as unknown as ChannelsService;

    await run(service, {
      toolkit: "slack",
      path: "/api/chat.postMessage?thread_ts=1700000000.000100",
      method: "POST",
      body: { channel: "C1", text: "re" },
    });
    await run(service, {
      toolkit: "slack",
      path: "/api/conversations.history?channel=D_PATH&limit=5",
      method: "GET",
      query: { channel: "D1" },
    });

    expect(send).toHaveBeenCalledWith(APP, "C1:1700000000.000100", { text: "re" });
    expect(queried).toHaveBeenCalledWith(APP, expect.objectContaining({ chatId: "D1", limit: 5 }));
  });

  it("points at Settings when Rome's Slack app is not connected", async () => {
    const service = {
      list: async () => [],
      send: rs.fn(),
      query: rs.fn(),
    } as unknown as ChannelsService;

    for (const channels of [service, undefined]) {
      const result = await run(channels, {
        toolkit: "slack",
        path: "/api/auth.test",
        method: "POST",
      });
      expect(result).toMatchObject({
        status: "error",
        error: expect.stringMatching(/Settings → Connections/),
      });
    }
  });

  it("still refuses an off-provider host before reaching the connection", async () => {
    const list = rs.fn();
    const result = await run({ list } as unknown as ChannelsService, {
      toolkit: "slack",
      path: "/api/chat.postMessage",
      host: "evil.example.com",
      method: "POST",
    });

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/Refusing to proxy/),
    });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("connector_proxy picks Rome's Slack app", () => {
  // Rome's Slack app is the one kind of connection on Slack with a talker, so
  // its channel is the one on the Slack platform, whatever its opaque name.
  it("takes the one channel on Slack, whatever it is named", async () => {
    const send = rs.fn(async () => ({ chatId: "D1", messageId: "1700000000.000200" }));
    const service = {
      list: async () => [
        {
          name: "1d9e-discord",
          account: { platform: "discord", id: "B9" },
          platform: "discord",
          sendable: true,
        },
        { name: "3f1c9a52-opaque", account: APP, platform: "slack", sendable: true },
      ],
      send,
      query: rs.fn(),
    } as unknown as ChannelsService;

    await run(service, {
      toolkit: "slack",
      path: "/api/chat.postMessage",
      method: "POST",
      body: { channel: "D1", text: "hi" },
    });

    expect(send).toHaveBeenCalledWith(APP, "D1", { text: "hi" });
  });

  it("fails a call while the Slack app's connection names no account", async () => {
    const locked = {
      list: async () => [{ name: "slack_app", platform: "slack", sendable: true }],
      send: rs.fn(),
      query: rs.fn(),
    } as unknown as ChannelsService;

    const result = await run(locked, {
      toolkit: "slack",
      path: "/api/chat.postMessage",
      method: "POST",
      body: { channel: "D1", text: "hi" },
    });

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/cannot make calls now/),
    });
    expect(locked.send).not.toHaveBeenCalled();
  });
});
