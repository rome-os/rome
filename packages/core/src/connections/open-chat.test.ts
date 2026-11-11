import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { channelChatId } from "../db/session-kind.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { chatsWiring } from "../chats-wiring.js";
import { ChannelWithoutAccount } from "./chat-adapter.js";
import { ChatAddresses } from "./chat-addresses.js";
import { openChannelChat, type OpenChannelChatDeps } from "./open-chat.js";
import { SessionRecords } from "../sessions/session-records.js";

describe("openChannelChat as a speaker", () => {
  let testDb: TestDb;
  let wired: ReturnType<typeof chatsWiring>;
  let deps: OpenChannelChatDeps;

  let telegramAccount: string;

  beforeEach(() => {
    testDb = createTestDb();
    telegramAccount = "111";
    wired = chatsWiring(testDb.db, {
      accountOf: (channel) =>
        channel === "telegram" ? { platform: "telegram", id: telegramAccount } : null,
      platformOfChannel: (name) => name,
      channelsOn: (platform) => [platform],
    });
    deps = {
      records: new SessionRecords(testDb.db, { triggerKindUnder: () => null }),
      speakers: { chats: wired.chats, adapters: wired.adapters, speakers: wired.speakers },
    };
  });
  afterEach(() => testDb.close());

  it("starts the chat in Chats and stands the session there as the channel's account", async () => {
    const record = await openChannelChat(deps, {
      channel: "telegram",
      threadId: "42",
      threadType: "private",
      agentName: "sales",
    });

    expect(wired.speakers.speakerOf(record.id)).toMatchObject({
      place: { chat: { platform: "telegram" } },
      accountId: "111",
      agent: "sales",
    });
  });

  it("binds no agent to a chat main answers", async () => {
    const record = await openChannelChat(deps, {
      channel: "telegram",
      threadId: "42",
      agentName: "main",
    });

    expect(record.agentName).toBeNull();
  });

  it("starts no chat at a dashboard address", async () => {
    await expect(
      openChannelChat(deps, { channel: "webchat", threadId: "chat-9", agentName: "main" }),
    ).rejects.toThrow("No chat at webchat address chat-9");
  });

  it("refuses a channel that does not know its account", async () => {
    await expect(
      openChannelChat(deps, { channel: "lark", threadId: "oc_1", agentName: "main" }),
    ).rejects.toThrow(ChannelWithoutAccount);
  });

  it("stands a thread's session in the thread of its chat", async () => {
    const record = await openChannelChat(deps, {
      channel: "telegram",
      threadId: "-100:7",
      parentThreadId: "-100",
      agentName: "main",
    });

    expect(wired.speakers.speakerOf(record.id)?.place.threadId).toBe("-100:7");
  });

  it("stands a session opened at a thread Rome knows in that thread of its chat", async () => {
    // A reply opened thread T in group G before anything was heard
    // in it, so only the thread's address is named.
    new ChatAddresses(testDb.db).bindThread({ platform: "telegram", id: "111" }, "T", "G");

    const record = await openChannelChat(deps, {
      channel: "telegram",
      threadId: "T",
      agentName: "main",
    });

    const speaker = wired.speakers.speakerOf(record.id);
    expect(speaker?.place.threadId).toBe("T");
    expect(speaker && wired.adapters.keyOf(speaker.place.chat).externalId).toBe("G");
  });

  it("keeps a session that already stands somewhere where it stands", async () => {
    const input = { channel: "telegram", threadId: "42", threadType: "private" as const };
    const first = await openChannelChat(deps, { ...input, agentName: "main" });
    const placed = wired.speakers.speakerOf(first.id);
    const again = await openChannelChat(deps, { ...input, agentName: "main" });

    expect(again.id).toBe(first.id);
    expect(wired.speakers.speakerOf(again.id)).toEqual(placed);
  });

  it("opens a group where the address says so, though a send named it private", async () => {
    const record = await openChannelChat(deps, {
      channel: "telegram",
      threadId: "-42",
      threadType: "private",
      agentName: "main",
    });

    const speaker = wired.speakers.speakerOf(record.id);
    expect(speaker && wired.adapters.keyOf(speaker.place.chat).externalId).toBe("-42");
  });

  it("moves a session to the chat of the account its channel is paired as now", async () => {
    const input = { channel: "telegram", threadId: "-42", threadType: "group" as const };
    const first = await openChannelChat(deps, { ...input, agentName: "main" });
    telegramAccount = "222";

    const again = await openChannelChat(deps, { ...input, agentName: "main" });

    expect(again.id).toBe(first.id);
    expect(wired.speakers.speakerOf(again.id)?.accountId).toBe("222");
  });
});
