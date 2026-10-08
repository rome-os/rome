import { describe, expect, it } from "@rstest/core";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import type { TalkHistory } from "../connections/types.js";
import type { Channel } from "./channel.js";
import { readTalkHistory } from "./talk-history.js";

// The window and page each store's retired read answered are pinned end to end
// by fetch_channel_history's parity test (rome_apps/system). This pins where
// the read goes and what it says when there is nothing to read.

const bare = (name: string): Channel => ({
  name,
  send: null,
  inbound: null,
  accounts: null,
  messages: null,
  directory: null,
});

describe("readTalkHistory", () => {
  it("says a connection has no history when nothing can read it", async () => {
    for (const source of [
      { channel: undefined, connectionHistory: null },
      { channel: bare("telegram"), connectionHistory: null },
      // A store's channel with no store behind it.
      { channel: bare("whatsapp"), connectionHistory: null },
    ]) {
      await expect(readTalkHistory(source, "conn-1", {})).rejects.toThrow(
        'Talk history is unavailable for connection "conn-1"',
      );
    }
  });

  it("reads a channel with no store from the named connection's history, input as given", async () => {
    const asked: unknown[] = [];
    const line = { messageId: "m1" } as ChannelMessage;
    const connectionHistory: TalkHistory = {
      query: async (input) => {
        asked.push(input);
        return [line];
      },
    };
    const input = { conversationId: "c1" as ConversationId, since: new Date(1_000), limit: 5 };

    const read = await readTalkHistory(
      { channel: bare("telegram"), connectionHistory },
      "conn-2",
      input,
    );

    expect(read).toEqual([line]);
    expect(asked).toEqual([input]);
  });
});
