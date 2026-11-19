import type { ActionConfig, AppActionRuntimeDeps, ChannelsService } from "@rome-os/app-runtime";
import { describe, expect, it, rs } from "@rstest/core";

// With no Slack sign-in token on disk, connector_proxy answers Slack through
// Rome's own Slack app connection: the channels service, never a token.
rs.mock("../api/slack-proxy.js", () => ({
  readSlackOAuthTokens: async () => null,
  slackProxyCall: () => {
    throw new Error("the Slack sign-in path must not be reached");
  },
}));

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
  it("sends through the Slack app connection when no sign-in token is held", async () => {
    const send = rs.fn(async () => ({ chatId: "D1", messageId: "1700000000.000200" }));
    const service = {
      list: async () => [
        { name: "slack_app", account: APP, platform: "slack", sendable: true, searchable: true },
      ],
      send,
      query: rs.fn(),
      search: rs.fn(),
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

  it("points at Settings when no Slack connection answers", async () => {
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
