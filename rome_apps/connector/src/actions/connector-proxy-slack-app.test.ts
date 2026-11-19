import type { ActionConfig, AppActionRuntimeDeps, ChannelsService } from "@rome-os/app-runtime";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";

// With no Slack sign-in token on disk, connector_proxy answers Slack through
// Rome's own Slack app connection: the channels service, never a token.
const readSlackOAuthTokens = rs.fn(async (): Promise<unknown> => null);
const slackProxyCall = rs.fn(async (): Promise<unknown> => {
  throw new Error("the Slack sign-in path must not be reached");
});
rs.mock("../api/slack-proxy.js", () => ({
  readSlackOAuthTokens: () => readSlackOAuthTokens(),
  slackProxyCall: (args: unknown) => slackProxyCall(args),
}));

const { createAction } = await import("./connector-proxy/index.js");

beforeEach(() => {
  readSlackOAuthTokens.mockResolvedValue(null);
});

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

describe("connector_proxy for Slack with both the sign-in and the Slack app connected", () => {
  const TOKENS = { botToken: "xoxb-old", userToken: null, teamId: "T1" };
  const app = () => {
    const send = rs.fn(async () => ({ chatId: "D1", messageId: "1700000000.000200" }));
    const service = {
      list: async () => [
        { name: "slack_app", account: APP, platform: "slack", sendable: true, searchable: true },
      ],
      send,
      query: rs.fn(),
      search: rs.fn(),
    } as unknown as ChannelsService;
    return { service, send };
  };
  const post = {
    toolkit: "slack",
    path: "/api/chat.postMessage",
    method: "POST",
    body: { channel: "D1", text: "hi" },
  };

  beforeEach(() => {
    readSlackOAuthTokens.mockResolvedValue(TOKENS);
    slackProxyCall.mockReset();
    slackProxyCall.mockResolvedValue({ status: 200, data: { ok: true, ts: "1.1" }, headers: {} });
  });

  it("takes the Slack app when the call names neither, and says which and why", async () => {
    const { service, send } = app();

    const result = await run(service, post);

    expect(send).toHaveBeenCalledWith(APP, "D1", { text: "hi" });
    expect(slackProxyCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "ok",
      data: { via: "app", note: expect.stringContaining('Pass via: "sign_in"') },
    });
  });

  it("takes the sign-in when the call names it, and says so", async () => {
    const { service, send } = app();

    const result = await run(service, { ...post, via: "sign_in" });

    expect(send).not.toHaveBeenCalled();
    expect(slackProxyCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ok", data: { via: "sign_in", data: { ok: true } } });
  });

  it("tells an agent whose method the app refuses that the sign-in can make it", async () => {
    const { service } = app();

    const result = await run(service, { toolkit: "slack", path: "/api/auth.test", method: "POST" });

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining('Pass via: "sign_in"'),
    });
    expect(slackProxyCall).not.toHaveBeenCalled();
  });

  it("fails a call the locked Slack app cannot make, and never falls back to the sign-in", async () => {
    const locked = {
      list: async () => [
        { name: "slack_app", platform: "slack", sendable: true, searchable: true },
      ],
      send: rs.fn(),
      query: rs.fn(),
      search: rs.fn(),
    } as unknown as ChannelsService;

    const result = await run(locked, post);

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/cannot make calls now.*Pass via: "sign_in"/),
    });
    expect(slackProxyCall).not.toHaveBeenCalled();
    expect(locked.send).not.toHaveBeenCalled();
  });

  it("refuses a connection the call names that is not connected", async () => {
    readSlackOAuthTokens.mockResolvedValue(null);
    const { service } = app();

    expect(await run(service, { ...post, via: "sign_in" })).toMatchObject({
      status: "error",
      error: expect.stringContaining("The Slack sign-in is not connected"),
    });
    readSlackOAuthTokens.mockResolvedValue(TOKENS);
    const none = {
      list: async () => [],
      send: rs.fn(),
      query: rs.fn(),
    } as unknown as ChannelsService;
    expect(await run(none, { ...post, via: "app" })).toMatchObject({
      status: "error",
      error: expect.stringMatching(/Settings → Connections/),
    });
    expect(slackProxyCall).not.toHaveBeenCalled();
  });
});
