import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ChannelMessage,
  ConversationId,
  NormalizedMessage,
  TalkHistory,
} from "@rome-os/app-runtime";
import { historyFeature } from "../connections/integrations/talk-features.js";
import {
  connectionPorts,
  LIVE_DEFAULT_WINDOW_MS,
  LIVE_READ_TTL_MS,
  type ConnectionPortsDeps,
} from "./connection-ports.js";
import { testMessagesQueryContract } from "./messages-contract.js";

// A channel with no store answers `query` through its Connection's history.
// That history reads a window rounded out to whole hours, as the adapters do,
// so the contract's `since` case is what pins the port's own cut.

const HOUR = 3_600_000;

function said(id: string, threadId: string, hoursAgo: number): NormalizedMessage {
  return {
    id,
    channel: "telegram_user",
    channelUserId: "7",
    displayName: "Chat",
    threadId,
    threadType: threadId === "group-1" ? "group" : "private",
    timestamp: new Date(Date.now() - hoursAgo * HOUR),
    text: id,
    attachments: [],
    rawEvent: null,
  };
}

testMessagesQueryContract("connection-backed messages", () => {
  const held = [
    // Inside the whole hour a `since` at g2 rounds out to, so a port that kept
    // the rounded window would answer g1 as well.
    said("g1", "group-1", 1.8),
    said("g2", "group-1", 1.5),
    said("g3", "group-1", 1.5),
    said("d1", "dm-1", 1),
  ];
  const history = historyFeature(
    {
      // An adapter's read: everything in the whole-hour window, oldest first.
      async fetchHistory(threadId, windowHours) {
        const cutoff = Date.now() - windowHours * HOUR;
        return held.filter(
          (m) => (threadId === null || m.threadId === threadId) && m.timestamp.getTime() >= cutoff,
        );
      },
    },
    { channel: "telegram_user" },
  );
  const deps = {
    registry: {
      getDescriptor: () => ({ capabilities: { talker: { history: true } } }),
      find: () => [{ id: "conn-1" }],
      onUnlocked: () => {},
      registeredServices: () => ["telegram_user"],
    },
    router: { feature: () => history },
  } as unknown as ConnectionPortsDeps;
  const messages = connectionPorts(deps, "telegram_user")?.messages;
  if (!messages) throw new Error("a talker with history backs the channel's messages");
  return {
    messages,
    channel: "telegram_user",
    conversation: "group-1" as ConversationId,
    silentConversation: "quiet-1" as ConversationId,
  };
});

describe("connection-backed messages", () => {
  // A line older than the default window: reached by naming a `since`, and
  // left out of a query that names none.
  it("reaches back the default window unless a since is named", async () => {
    const old = said("old", "dm-1", 30);
    const recent = said("recent", "dm-1", 1);
    const history = historyFeature(
      {
        async fetchHistory(_threadId, windowHours) {
          const cutoff = Date.now() - windowHours * HOUR;
          return [old, recent].filter((m) => m.timestamp.getTime() >= cutoff);
        },
      },
      { channel: "telegram_user" },
    );
    const deps = {
      registry: {
        getDescriptor: () => ({ capabilities: { talker: { history: true } } }),
        find: () => [{ id: "conn-1" }],
        onUnlocked: () => {},
        registeredServices: () => ["telegram_user"],
      },
      router: { feature: () => history },
    } as unknown as ConnectionPortsDeps;
    const messages = connectionPorts(deps, "telegram_user")?.messages;

    expect(LIVE_DEFAULT_WINDOW_MS).toBe(24 * HOUR);
    const ids = (page: Array<{ messageId: string }> | undefined) => page?.map((m) => m.messageId);
    expect(ids(await messages?.query({}))).toEqual(["recent"]);
    expect(ids(await messages?.query({ since: new Date(Date.now() - 48 * HOUR) }))).toEqual([
      "recent",
      "old",
    ]);
  });
});

describe("connection-backed messages, shared reads", () => {
  const NOW = Date.parse("2026-09-30T12:00:00.000Z");
  let clock = NOW;
  afterEach(() => {
    rs.restoreAllMocks();
    clock = NOW;
  });

  function line(id: string, minutesAgo: number): ChannelMessage {
    return {
      channel: "telegram_user",
      direction: "inbound",
      messageId: id,
      conversationId: "dm-1" as ConversationId,
      senderId: "7",
      text: id,
      attachments: [],
      timestamp: new Date(NOW - minutesAgo * 60_000),
    };
  }

  // A live read that counts itself, answering `lines(input)` oldest first.
  function port(lines: (input: { since?: Date }) => ChannelMessage[] | Promise<ChannelMessage[]>) {
    rs.spyOn(Date, "now").mockImplementation(() => clock);
    const query = rs.fn<TalkHistory["query"]>(async (input) => lines(input));
    const deps = {
      registry: {
        getDescriptor: () => ({ capabilities: { talker: { history: true } } }),
        find: () => [{ id: "conn-1" }],
        onUnlocked: () => {},
        registeredServices: () => ["telegram_user"],
      },
      router: { feature: () => ({ query }) },
    } as unknown as ConnectionPortsDeps;
    const messages = connectionPorts(deps, "telegram_user")?.messages;
    if (!messages) throw new Error("a talker with history backs the channel's messages");
    return { messages, query };
  }

  const ids = (page: ChannelMessage[]) => page.map((m) => m.messageId);

  it("shares a read over the same whole-hour window", async () => {
    const { messages, query } = port(() => [line("older", 50), line("newer", 5)]);

    await messages.query({ since: new Date(NOW - 60 * 60_000) });
    clock += LIVE_READ_TTL_MS - 1;
    const narrower = await messages.query({ since: new Date(NOW - 10 * 60_000), limit: 5 });

    expect(query).toHaveBeenCalledTimes(1);
    expect(ids(narrower)).toEqual(["newer"]);
  });

  it("shares a read still under way", async () => {
    const { messages, query } = port(() => [line("only", 5)]);

    const [first, second] = await Promise.all([messages.query({}), messages.query({})]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(ids(first)).toEqual(["only"]);
    expect(ids(second)).toEqual(["only"]);
  });

  it("reads again once the read is stale, or reaches further back", async () => {
    const { messages, query } = port(() => [line("only", 5)]);

    await messages.query({ since: new Date(NOW - 60 * 60_000) });
    await messages.query({ since: new Date(NOW - 120 * 60_000) });
    clock += LIVE_READ_TTL_MS;
    await messages.query({ since: new Date(NOW - 60 * 60_000) });

    expect(query).toHaveBeenCalledTimes(3);
  });

  it("keeps a conversation's read apart from the whole account's", async () => {
    const { messages, query } = port(() => [line("only", 5)]);

    await messages.query({});
    await messages.query({ conversationId: "dm-1" as ConversationId });

    expect(query).toHaveBeenCalledTimes(2);
  });

  // Discord keeps the oldest lines of each channel after its cutoff, so a
  // day's read of a busy channel can hold none of the last hour's.
  it("does not answer a narrower window from a wider read", async () => {
    const said = [line("day-1", 20 * 60), line("day-2", 19 * 60), line("recent", 30)];
    const oldestTwo = ({ since }: { since?: Date }) =>
      said.filter((m) => m.timestamp.getTime() >= (since?.getTime() ?? 0)).slice(0, 2);
    const { messages, query } = port(oldestTwo);

    expect(ids(await messages.query({}))).toEqual(["day-2", "day-1"]);
    expect(ids(await messages.query({ since: new Date(NOW - 60 * 60_000) }))).toEqual(["recent"]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed read", async () => {
    let fail = true;
    const { messages, query } = port(() => {
      if (fail) throw new Error("platform down");
      return [line("only", 5)];
    });

    await expect(messages.query({})).rejects.toThrow("platform down");
    fail = false;
    expect(ids(await messages.query({}))).toEqual(["only"]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
