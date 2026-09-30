import { describe, expect, it } from "@rstest/core";
import type { Channel } from "../channels/channel.js";
import { readTalkHistory } from "./talk-history.js";

// The window and page each retired read answered are pinned end to end by
// fetch_channel_history's parity test (rome_apps/system). This pins what the
// read says when there is nothing to read.

describe("readTalkHistory", () => {
  it("says a connection has no history when its channel reads none", async () => {
    const channel: Channel = {
      name: "telegram",
      send: null,
      inbound: null,
      accounts: null,
      messages: null,
    };
    for (const unread of [channel, undefined]) {
      await expect(readTalkHistory(unread, "conn-1", {})).rejects.toThrow(
        'Talk history is unavailable for connection "conn-1"',
      );
    }
  });
});
