import type { ChannelMessage, ChannelsService, ChatId } from "@rome-os/app-runtime";
import { describe, expect, it, rs } from "@rstest/core";

import { slackAppConnection, slackAppProxyCall } from "./slack-app-proxy.js";

// Rome's Slack app connection answers Slack's Web API through the channels
// service, which holds no token here; fake the service and assert what each
// Slack method becomes.

const APP = { platform: "slack", id: "T1/B1" };

function said(ts: string, extra: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channel: "slack_app",
    direction: "inbound",
    chatId: "D1" as ChatId,
    messageId: ts,
    senderId: "T1/U1",
    senderDisplayName: "Ouou",
    text: `said at ${ts}`,
    attachments: [],
    timestamp: new Date(Number(ts) * 1_000),
    ...extra,
  };
}

function channels(overrides: Partial<ChannelsService> = {}) {
  return {
    list: rs.fn(async () => [
      {
        name: "slack",
        account: { platform: "slack", id: "T1/BOLD" },
        platform: "slack",
        sendable: true,
      },
      { name: "slack_app", account: APP, platform: "slack", sendable: true, searchable: true },
    ]),
    send: rs.fn(async () => ({ chatId: "D1" as ChatId, messageId: "1700000000.000200" })),
    query: rs.fn(async () => [said("1700000000.000300"), said("1700000000.000100")]),
    search: rs.fn(async () => ({
      messages: [said("1700000000.000100", { chatId: "C1:1699999999.000001" as ChatId })],
      coverage: "what Rome kept",
    })),
    ...overrides,
  } satisfies ChannelsService;
}

const call = (
  service: ChannelsService,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
) => slackAppProxyCall({ channels: service, account: APP, path, body, query });

describe("Slack's Web API through Rome's Slack app", () => {
  it("finds the Slack account whose channel searches, not the Slack bot's", async () => {
    expect(await slackAppConnection(channels())).toEqual({ account: APP });
    expect(await slackAppConnection(channels({ list: async () => [] }))).toBeNull();
    const locked = channels({
      list: async () => [
        { name: "slack_app", platform: "slack", sendable: true, searchable: true },
      ],
    });
    expect(await slackAppConnection(locked)).toEqual({ account: null });
  });

  it("sends chat.postMessage as the app, into a thread when it names one", async () => {
    const service = channels();

    const top = await call(service, "/api/chat.postMessage", { channel: "D1", text: "hi" });
    await call(service, "/api/chat.postMessage", {
      channel: "C1",
      text: "re",
      thread_ts: "1.000002",
    });

    expect(service.send).toHaveBeenNthCalledWith(1, APP, "D1", { text: "hi" });
    expect(service.send).toHaveBeenNthCalledWith(2, APP, "C1:1.000002", { text: "re" });
    expect(top).toEqual({
      status: "ok",
      data: {
        status: 200,
        data: { ok: true, channel: "D1", ts: "1700000000.000200" },
        headers: {},
      },
    });
  });

  it("reads conversations.history from the connection, newest first, paging back from latest", async () => {
    const service = channels();

    const result = await call(service, "/api/conversations.history", undefined, {
      channel: "D1",
      limit: "2",
      latest: "1700000000.000400",
      oldest: "1700000000",
    });

    expect(service.query).toHaveBeenCalledWith(APP, {
      chatId: "D1",
      limit: 2,
      olderThan: "1700000000.000400",
      since: new Date(1_700_000_000_000),
    });
    if (result.status !== "ok") throw new Error(result.error);
    expect(result.data.data).toMatchObject({
      ok: true,
      has_more: true,
      messages: [
        { ts: "1700000000.000300", user: "U1", text: "said at 1700000000.000300" },
        { ts: "1700000000.000100" },
      ],
    });
  });

  it("says more history may be left whenever a page held a message, even a short one", async () => {
    const short = await call(channels(), "/api/conversations.history", undefined, {
      channel: "D1",
      limit: "100",
    });
    const empty = await call(
      channels({ query: rs.fn(async () => []) }),
      "/api/conversations.history",
      undefined,
      { channel: "D1", latest: "1600000000.000000" },
    );

    if (short.status !== "ok" || empty.status !== "ok") throw new Error("history failed");
    expect(short.data.data).toMatchObject({ has_more: true });
    expect(empty.data.data).toMatchObject({ has_more: false, messages: [] });
  });

  it("leaves out messages at or before oldest, to the microsecond, as Slack does", async () => {
    const service = channels({
      query: rs.fn(async () => [
        said("1700000000.000500"),
        said("1700000000.000400"),
        said("1700000000.000100"),
      ]),
    });

    const result = await call(service, "/api/conversations.history", undefined, {
      channel: "D1",
      oldest: "1700000000.000400",
    });

    if (result.status !== "ok") throw new Error(result.error);
    expect(result.data.data).toMatchObject({
      messages: [{ ts: "1700000000.000500" }],
      has_more: false,
    });
    expect((result.data.data as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("answers search.messages with its matches and says what the search covered", async () => {
    const service = channels();

    const result = await call(service, "/api/search.messages", undefined, {
      query: "launch",
      count: "5",
    });

    expect(service.search).toHaveBeenCalledWith(APP, { text: "launch", limit: 5 });
    if (result.status !== "ok") throw new Error(result.error);
    expect(result.data.data).toMatchObject({
      ok: true,
      query: "launch",
      coverage: "what Rome kept",
      messages: { total: 1, matches: [{ ts: "1700000000.000100", channel: { id: "C1" } }] },
    });
  });

  it("refuses any other method, naming what it offers, and reaches nothing", async () => {
    const service = channels();

    for (const path of [
      "/api/auth.test",
      "/api/conversations.list",
      "/api/conversations.replies",
    ]) {
      const result = await call(service, path, {});
      expect(result).toEqual({
        status: "error",
        error: expect.stringContaining(
          `isn't offered on Rome's Slack app connection. It offers chat.postMessage (send), conversations.history (read) and search.messages`,
        ),
      });
    }
    expect(service.send).not.toHaveBeenCalled();
    expect(service.query).not.toHaveBeenCalled();
    expect(service.search).not.toHaveBeenCalled();
  });

  it("fails closed when the connection refuses, or the call lacks what the method takes", async () => {
    const service = channels({
      send: rs.fn(async () => {
        throw new Error("No connection reaches account");
      }),
    });

    expect(await call(service, "/api/chat.postMessage", { channel: "D1", text: "hi" })).toEqual({
      status: "error",
      error:
        'Slack "chat.postMessage" through Rome\'s Slack app failed: No connection reaches account',
    });
    expect((await call(service, "/api/chat.postMessage", { channel: "D1" })).status).toBe("error");
    expect((await call(service, "/api/search.messages", {})).status).toBe("error");
  });
});
