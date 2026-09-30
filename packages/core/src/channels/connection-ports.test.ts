import { describe, expect, it } from "@rstest/core";
import type { ConversationId, NormalizedMessage } from "@rome-os/app-runtime";
import { historyFeature } from "../connections/integrations/talk-features.js";
import {
  connectionPorts,
  LIVE_DEFAULT_WINDOW_MS,
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
