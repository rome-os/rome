import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { REST } from "discord.js";
import { DiscordAdapter } from "./discord.js";

afterEach(() => {
  rs.restoreAllMocks();
});

describe("DiscordAdapter history", () => {
  it("reads a channel's REST messages as the channel's inbound record", async () => {
    // Discord answers newest first; the read keeps people's lines, oldest first.
    const restMessages = [
      {
        id: "m3",
        content: "beep",
        author: { id: "bot-1", username: "bot", bot: true },
        timestamp: "2026-10-08T07:02:00.000Z",
        attachments: [],
      },
      {
        id: "m2",
        content: "see attached",
        author: { id: "u2", username: "bea", global_name: null },
        timestamp: "2026-10-08T07:01:00.000Z",
        attachments: [
          {
            filename: "580f8fdeeb994c86.txt",
            title: "notes",
            url: "https://cdn.discordapp.com/attachments/1/2/580f8fdeeb994c86.txt",
            content_type: "text/plain",
          },
        ],
      },
      {
        id: "m1",
        content: "hello",
        author: { id: "u1", username: "ann", global_name: "Ann" },
        timestamp: "2026-10-08T07:00:00.000Z",
        attachments: [],
      },
    ];
    const [, , ann] = restMessages;
    // The adapter reorders the answer in place, so hand it a copy.
    const get = rs.spyOn(REST.prototype, "get").mockResolvedValue([...restMessages]);
    const adapter = new DiscordAdapter({ botToken: "not-exposed" });

    const messages = await adapter.fetchHistory("chan-1", 24);

    expect(get).toHaveBeenCalledOnce();
    expect(messages.map((message) => message.messageId)).toEqual(["m1", "m2"]);
    expect(messages[0]).toEqual({
      channel: "discord",
      direction: "inbound",
      messageId: "m1",
      chatId: "chan-1",
      senderId: "u1",
      senderDisplayName: "Ann",
      senderUsername: "ann",
      text: "hello",
      attachments: [],
      timestamp: new Date("2026-10-08T07:00:00.000Z"),
      thread: { kind: "group", name: "discord/#chan-1" },
      raw: ann,
    });
    expect(messages[1]).toMatchObject({
      senderDisplayName: "bea",
      attachments: [
        {
          type: "document",
          url: "https://cdn.discordapp.com/attachments/1/2/580f8fdeeb994c86.txt",
          mimeType: "text/plain",
          fileName: "notes.txt",
        },
      ],
    });
  });

  it("asks for the newest messages when the window starts before Discord's epoch", async () => {
    const get = rs.spyOn(REST.prototype, "get").mockResolvedValue([]);
    const adapter = new DiscordAdapter({ botToken: "not-exposed" });

    // A read with no bound arrives as a window back to 1970.
    await adapter.fetchHistory("chan-1", Date.now() / 3_600_000 + 1);
    await adapter.fetchHistory("chan-1", 24);

    const [unbounded, recent] = get.mock.calls.map((call) => call[1] as { query: URLSearchParams });
    expect(unbounded?.query.has("after")).toBe(false);
    expect(unbounded?.query.get("limit")).toBe("100");
    expect(BigInt(recent?.query.get("after") ?? "0")).toBeGreaterThan(0n);
  });
});
