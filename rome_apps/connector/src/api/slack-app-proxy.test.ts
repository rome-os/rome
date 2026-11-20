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

  it("sends nothing on a verb Slack's method does not take, and reads by GET or POST", async () => {
    const service = channels();
    const send = (method: string) =>
      slackAppProxyCall({
        channels: service,
        account: APP,
        method,
        path: "/api/chat.postMessage",
        query: { channel: "D1", text: "hi" },
      });

    for (const verb of ["HEAD", "GET", "DELETE"]) {
      expect(await send(verb)).toEqual({
        status: "error",
        error: `Slack "chat.postMessage" takes POST, not ${verb}. Nothing was sent or read.`,
      });
    }
    expect(service.send).not.toHaveBeenCalled();
    expect((await send("post")).status).toBe("ok");
    for (const verb of ["GET", "POST"]) {
      const read = await slackAppProxyCall({
        channels: service,
        account: APP,
        method: verb,
        path: "/api/conversations.history",
        query: { channel: "D1" },
      });
      expect(read.status).toBe("ok");
    }
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

  it("reads a latest given in whole seconds as a Slack message time, and refuses one that is no time", async () => {
    const service = channels();

    await call(service, "/api/conversations.history", undefined, {
      channel: "D1",
      latest: "1700000000",
    });
    await call(service, "/api/conversations.history", { channel: "D1", latest: 1700000000.5 });
    const refused = await call(service, "/api/conversations.history", undefined, {
      channel: "D1",
      latest: "yesterday",
    });

    expect(service.query).toHaveBeenNthCalledWith(1, APP, {
      chatId: "D1",
      limit: 100,
      olderThan: "1700000000.000000",
    });
    expect(service.query).toHaveBeenNthCalledWith(2, APP, {
      chatId: "D1",
      limit: 100,
      olderThan: "1700000000.500000",
    });
    expect(refused.status).toBe("error");
    expect(service.query).toHaveBeenCalledTimes(2);
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

    for (const path of ["/api/auth.test", "/api/users.info", "/api/reactions.add"]) {
      const result = await call(service, path, {});
      expect(result).toEqual({
        status: "error",
        error: expect.stringContaining(
          `isn't offered on Rome's Slack app connection. It offers chat.postMessage (send), conversations.history and conversations.replies (read), conversations.list`,
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

  it("reads a thread with conversations.replies, oldest first, and goes on from its cursor until a page is empty", async () => {
    // A thread longer than Slack's page of 15: the connection answers it a
    // page at a time.
    const first = Array.from({ length: 15 }, (_, i) =>
      said(`1700000000.${String(100 + i).padStart(6, "0")}`),
    ).reverse();
    const second = [said("1700000000.000200")];
    const query = rs
      .fn<ChannelsService["query"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce([]);
    const service = channels({ query });
    const read = async (extra: Record<string, string> = {}) => {
      const result = await call(service, "/api/conversations.replies", undefined, {
        channel: "C1",
        ts: "1700000000.000100",
        ...extra,
      });
      if (result.status !== "ok") throw new Error(result.error);
      return result.data.data as {
        messages: Array<{ ts: string }>;
        has_more: boolean;
        response_metadata: { next_cursor: string };
      };
    };

    const one = await read();
    const two = await read({ cursor: one.response_metadata.next_cursor });
    const three = await read({ cursor: two.response_metadata.next_cursor });

    expect(query).toHaveBeenNthCalledWith(1, APP, { chatId: "C1:1700000000.000100", limit: 100 });
    expect(query).toHaveBeenNthCalledWith(2, APP, {
      chatId: "C1:1700000000.000100",
      limit: 100,
      newerThan: "1700000000.000114",
    });
    expect(one.messages[0]?.ts).toBe("1700000000.000100");
    expect(one.messages).toHaveLength(15);
    expect(one).toMatchObject({ has_more: true });
    expect(two).toMatchObject({
      messages: [{ ts: "1700000000.000200" }],
      has_more: true,
      response_metadata: { next_cursor: "1700000000.000200" },
    });
    expect(three).toMatchObject({
      messages: [],
      has_more: false,
      response_metadata: { next_cursor: "" },
    });
  });

  it("refuses a thread cursor that is not a Slack time, reading nothing", async () => {
    const service = channels();
    const result = await call(service, "/api/conversations.replies", undefined, {
      channel: "C1",
      ts: "1700000000.000100",
      cursor: "dXNlcjpVMDYxTkZUVDI=",
    });
    expect(result.status).toBe("error");
    expect(service.query).not.toHaveBeenCalled();
  });

  it("lists the channels the app is a member of through its own connection", async () => {
    const chats = rs.fn(async () => ({
      chats: [{ chatId: "C_NEWS" as ChatId, name: "#news", kind: "channel" as const }],
      nextCursor: "next",
    }));

    const result = await call(channels({ chats }), "/api/conversations.list", undefined, {
      limit: "20",
      query: "ne",
    });

    expect(chats).toHaveBeenCalledWith(APP, { limit: 20, query: "ne" });
    if (result.status !== "ok") throw new Error(result.error);
    expect(result.data.data).toEqual({
      ok: true,
      channels: [{ id: "C_NEWS", name: "news", is_member: true }],
      response_metadata: { next_cursor: "next" },
    });
  });

  it("fails a listing Slack refuses, with its reason, rather than answer no channels", async () => {
    const chats = rs.fn(async () => {
      throw new Error("Rome's Slack app may not see channels in this workspace yet");
    });

    const result = await call(channels({ chats }), "/api/conversations.list");

    expect(result).toMatchObject({ status: "error" });
    if (result.status !== "error") throw new Error("expected a refusal");
    expect(result.error).toContain("may not see channels in this workspace yet");
  });
});
