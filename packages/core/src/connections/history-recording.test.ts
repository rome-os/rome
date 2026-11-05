import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn } from "../chats/storage/place.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatAddresses } from "./chat-addresses.js";
import { chatKey, directMessageKey } from "./chat-ids.js";
import { recordSynced, type SyncedMessage } from "./history-recording.js";
import { syncedFromWhatsApp } from "./kinds/whatsapp/whatsapp-sync.js";

const SELF = "1000@s.whatsapp.net";
const ACCOUNT = { platform: "whatsapp", id: SELF };

function synced(overrides: Partial<SyncedMessage> = {}): SyncedMessage {
  return {
    address: "2000@s.whatsapp.net",
    kind: "dm",
    id: "m1",
    sender: { id: "2000@s.whatsapp.net", name: "Alice" },
    text: "hello",
    at: new Date("2026-11-01T10:00:00Z"),
    ...overrides,
  };
}

describe("recordSynced", () => {
  let testDb: TestDb;
  let chats: ChatRepository;
  let messages: MessageRepository;
  let addresses: ChatAddresses;
  let deps: { chats: ChatRepository; messages: MessageRepository; addresses: ChatAddresses };

  beforeEach(() => {
    testDb = createTestDb();
    chats = new ChatRepository(testDb.db);
    messages = new MessageRepository(testDb.db);
    addresses = new ChatAddresses(testDb.db);
    deps = { chats, messages, addresses };
  });

  afterEach(() => {
    testDb.close();
  });

  const said = (key: ReturnType<typeof chatKey>) => {
    const chat = chats.byKey(key);
    if (!chat) return [];
    return messages.read(placeIn(chat.ref)).messages.map((message) => ({
      key: message.key,
      sender: message.saidBy?.account.id,
      text: message.body.text,
    }));
  };

  it("records a direct message in the chat between both ends, and a group message in the group", () => {
    const recorded = recordSynced(deps, ACCOUNT, [
      synced(),
      synced({
        address: "team@g.us",
        kind: "group",
        id: "g1",
        sender: { id: "3000@s.whatsapp.net" },
        text: "standup",
      }),
    ]);

    expect(recorded).toEqual({ recorded: 2, onRecord: ["m1", "g1"] });
    expect(said(directMessageKey("whatsapp", SELF, "2000@s.whatsapp.net"))).toEqual([
      { key: "m1", sender: "2000@s.whatsapp.net", text: "hello" },
    ]);
    expect(chats.byKey(directMessageKey("whatsapp", SELF, "2000@s.whatsapp.net"))?.kind).toBe("dm");
    expect(said(chatKey("whatsapp", "team@g.us" as ChatId))).toEqual([
      { key: "g1", sender: "3000@s.whatsapp.net", text: "standup" },
    ]);
  });

  it("records the guardian's own message under Rome's account", () => {
    recordSynced(deps, ACCOUNT, [synced({ id: "own", sender: { id: SELF }, text: "on my way" })]);

    expect(said(directMessageKey("whatsapp", SELF, "2000@s.whatsapp.net"))).toEqual([
      { key: "own", sender: SELF, text: "on my way" },
    ]);
  });

  it("records a message already on record once, and skips one with nothing in it", () => {
    expect(recordSynced(deps, ACCOUNT, [synced()])).toEqual({ recorded: 1, onRecord: ["m1"] });
    expect(recordSynced(deps, ACCOUNT, [synced(), synced({ id: "empty", text: "  " })])).toEqual({
      recorded: 0,
      onRecord: ["m1"],
    });

    expect(said(directMessageKey("whatsapp", SELF, "2000@s.whatsapp.net"))).toHaveLength(1);
  });

  it("records media, which the sync keeps no file of, as a note of its kind and caption", () => {
    recordSynced(deps, ACCOUNT, [
      synced({ id: "voice", text: "", attachments: [{ type: "audio" }] }),
      synced({ id: "photo", text: "", attachments: [{ type: "image", caption: "sunset" }] }),
    ]);

    expect(said(directMessageKey("whatsapp", SELF, "2000@s.whatsapp.net"))).toEqual([
      { key: "voice", sender: "2000@s.whatsapp.net", text: "[audio]" },
      { key: "photo", sender: "2000@s.whatsapp.net", text: "[image: sunset]" },
    ]);
  });

  it("records a direct message in the chat Rome already reaches at its address", () => {
    const held = directMessageKey("whatsapp", SELF, "opened-by-send");
    chats.start(held, "dm", null);
    addresses.bind(ACCOUNT, held.externalId, "2000@s.whatsapp.net");

    recordSynced(deps, ACCOUNT, [synced()]);

    expect(said(held)).toEqual([{ key: "m1", sender: "2000@s.whatsapp.net", text: "hello" }]);
    expect(chats.byKey(directMessageKey("whatsapp", SELF, "2000@s.whatsapp.net"))).toBeNull();
  });
});

describe("syncedFromWhatsApp", () => {
  const base = {
    id: "w1",
    chatJid: "2000@s.whatsapp.net",
    senderJid: "2000@s.whatsapp.net",
    fromMe: false,
    timestamp: new Date("2026-11-01T10:00:00Z"),
    type: "text",
    text: "hi",
    hasMedia: false,
    pushName: "Alice",
    reactsToId: null,
  };

  it("names the guardian's own message by Rome's account and its display name, not the push name", () => {
    expect(
      syncedFromWhatsApp({ ...base, fromMe: true, senderJid: null }, SELF, "Ouou"),
    ).toMatchObject({
      kind: "dm",
      address: "2000@s.whatsapp.net",
      sender: { id: SELF, name: "Ouou" },
    });
    expect(
      syncedFromWhatsApp({ ...base, fromMe: true, senderJid: null }, SELF)?.sender,
    ).not.toHaveProperty("name");
  });

  it("reads a group message as said by its participant", () => {
    expect(
      syncedFromWhatsApp({ ...base, chatJid: "team@g.us", senderJid: "3000@s.whatsapp.net" }, SELF),
    ).toMatchObject({ kind: "group", sender: { id: "3000@s.whatsapp.net", name: "Alice" } });
  });

  it("keeps media as its kind with its caption, and leaves reactions out", () => {
    expect(
      syncedFromWhatsApp({ ...base, type: "image", hasMedia: true, text: "sunset" }, SELF)
        ?.attachments,
    ).toEqual([{ type: "image", caption: "sunset" }]);
    expect(
      syncedFromWhatsApp({ ...base, type: "image", hasMedia: true, text: "sunset" }, SELF)?.text,
    ).toBe("");
    expect(
      syncedFromWhatsApp({ ...base, type: "reaction", text: "👍", reactsToId: "w0" }, SELF),
    ).toBeNull();
  });

  it("leaves out statuses, broadcast lists and channel posts, which are no chat", () => {
    for (const chatJid of ["status@broadcast", "1234@broadcast", "1200@newsletter"]) {
      expect(syncedFromWhatsApp({ ...base, chatJid, fromMe: true }, SELF)).toBeNull();
    }
  });
});
