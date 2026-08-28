import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb } from "../../test/helpers.js";
import type { DrizzleDb } from "../index.js";
import { WhatsAppStoreRepository } from "./whatsapp-store.js";
import { PersonMappingRepository } from "./person-mapping.js";

describe("WhatsAppStoreRepository", () => {
  let db: DrizzleDb;
  let close: () => void;
  let repo: WhatsAppStoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    close = t.close;
    repo = new WhatsAppStoreRepository(db);
  });

  afterEach(() => close());

  it("upserts contacts and lists them", async () => {
    await repo.upsertContacts([
      { jid: "111@s.whatsapp.net", phoneNumber: "111", name: "Alice", notify: "Ali" },
      { jid: "222@s.whatsapp.net", phoneNumber: "222", notify: "Bob" },
    ]);

    const rows = await repo.listContacts();
    expect(rows).toHaveLength(2);
    const alice = rows.find((r) => r.jid === "111@s.whatsapp.net");
    expect(alice?.name).toBe("Alice");
    expect(alice?.linkedPersonId).toBeNull();
    expect(alice?.messageCount).toBe(0);
  });

  it("bounds the address-book read by default and reads it whole on limit: null", async () => {
    await repo.upsertContacts([
      { jid: "15550000001@s.whatsapp.net", phoneNumber: "15550000001", name: "Ada" },
      { jid: "15550000002@s.whatsapp.net", phoneNumber: "15550000002", name: "Bea" },
      { jid: "15550000003@s.whatsapp.net", phoneNumber: "15550000003", name: "Cy" },
    ]);

    expect(await repo.listContacts({ limit: 2 })).toHaveLength(2);
    expect(await repo.listContacts({ limit: null })).toHaveLength(3);
    // The no-argument call is what `/api/whatsapp/contacts` makes.
    expect(await repo.listContacts()).toHaveLength(3);
  });

  it("hides nameless LID-only contacts but keeps LIDs with a phone number", async () => {
    await repo.upsertContacts([
      { jid: "raw-lid@lid" },
      { jid: "phone-backed@lid", phoneNumber: "15551234567" },
      { jid: "named-lid@lid", name: "Lia" },
    ]);

    const rows = await repo.listContacts();
    expect(rows.map((r) => r.jid)).not.toContain("raw-lid@lid");
    expect(rows.map((r) => r.jid)).toEqual(
      expect.arrayContaining(["phone-backed@lid", "named-lid@lid"]),
    );
  });

  it("merges a contact's LID conversation thread with its phone-number address-book row", async () => {
    // WhatsApp delivers the conversation under the privacy LID (carrying the
    // resolved phone number) while the saved name lives on the @s.whatsapp.net
    // row — two threads for one person. They must collapse into a single card
    // that keeps the name AND the conversation.
    await repo.upsertContacts([
      { jid: "lid-may@lid", phoneNumber: "15555550148" }, // conversation side, no name
      { jid: "15555550148@s.whatsapp.net", phoneNumber: "15555550148", name: "may" },
    ]);
    await repo.upsertMessages([
      {
        id: "m1",
        chatJid: "lid-may@lid",
        fromMe: false,
        timestamp: new Date(1_700_000_000_000),
        type: "text",
        text: "哪两个？",
        hasMedia: false,
      },
    ]);

    const rows = await repo.listContacts();
    const may = rows.filter((r) => (r.phoneNumber ?? "").includes("15555550148"));
    expect(may).toHaveLength(1); // one card, not two
    expect(may[0].name).toBe("may"); // name surfaced from the address-book sibling
    expect(may[0].jid).toBe("lid-may@lid"); // conversation-bearing jid, so the chat opens
    expect(may[0].lastMessagePreview).toBe("哪两个？");
    expect(may[0].messageCount).toBe(1);
  });

  it("carries a person link across the merged account", async () => {
    const persons = new PersonMappingRepository(db);
    await persons.create({
      displayName: "May",
      bondLevel: "acquaintance",
      channelMappings: [{ channel: "whatsapp", channelUserId: "15555550148@s.whatsapp.net" }],
    });
    await repo.upsertContacts([
      { jid: "lid-may@lid", phoneNumber: "15555550148" },
      { jid: "15555550148@s.whatsapp.net", phoneNumber: "15555550148", name: "may" },
    ]);

    const rows = await repo.listContacts();
    const may = rows.filter((r) => (r.phoneNumber ?? "").includes("15555550148"));
    expect(may).toHaveLength(1);
    expect(may[0].linkedPersonId).toBeTruthy();
    expect(may[0].linkedPersonName).toBe("May");
  });

  it("keeps distinct phone numbers and nameless phone-less LIDs as separate cards", async () => {
    // Guards against over-merging: only a shared phone number folds two threads.
    await repo.upsertContacts([
      { jid: "111@s.whatsapp.net", phoneNumber: "111", name: "Alice" },
      { jid: "222@s.whatsapp.net", phoneNumber: "222", name: "Bob" },
      { jid: "named-lid@lid", name: "Lia" }, // no phone → keys on its own jid
    ]);

    const rows = await repo.listContacts();
    expect(rows.map((r) => r.jid)).toEqual(
      expect.arrayContaining(["111@s.whatsapp.net", "222@s.whatsapp.net", "named-lid@lid"]),
    );
    expect(rows).toHaveLength(3);
  });

  it("surfaces group chats without contact rows, but not private chat-only rows", async () => {
    await repo.upsertChats([
      { jid: "120@g.us", name: "Launch crew", isGroup: true },
      { jid: "15551234567@s.whatsapp.net", name: "Private thread", isGroup: false },
    ]);
    await repo.upsertMessages([
      {
        id: "g1",
        chatJid: "120@g.us",
        fromMe: false,
        timestamp: new Date(1_700_000_000_000),
        type: "text",
        text: "group hello",
        hasMedia: false,
      },
      {
        id: "p1",
        chatJid: "15551234567@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_001_000),
        type: "text",
        text: "private hello",
        hasMedia: false,
      },
    ]);

    const rows = await repo.listContacts();
    expect(rows.map((r) => r.jid)).not.toContain("15551234567@s.whatsapp.net");
    const group = rows.find((r) => r.jid === "120@g.us");
    expect(group).toMatchObject({
      chatName: "Launch crew",
      isGroup: true,
      lastMessagePreview: "group hello",
      messageCount: 1,
    });
  });

  it("does not clobber existing fields with a partial update", async () => {
    await repo.upsertContacts([
      { jid: "111@s.whatsapp.net", phoneNumber: "111", name: "Alice", notify: "Ali" },
    ]);
    // A partial `contacts.update`-style payload with only a new notify.
    await repo.upsertContacts([{ jid: "111@s.whatsapp.net", notify: "Alice 🌸" }]);

    const rows = await repo.listContacts();
    const alice = rows.find((r) => r.jid === "111@s.whatsapp.net");
    expect(alice?.name).toBe("Alice"); // preserved
    expect(alice?.notify).toBe("Alice 🌸"); // updated
    expect(alice?.phoneNumber).toBe("111"); // preserved
  });

  it("annotates contacts linked to a person", async () => {
    const persons = new PersonMappingRepository(db);
    await persons.create({
      displayName: "Alice Smith",
      bondLevel: "inner-circle",
      channelMappings: [{ channel: "whatsapp", channelUserId: "111@s.whatsapp.net" }],
    });
    await repo.upsertContacts([{ jid: "111@s.whatsapp.net", name: "Alice" }]);

    const rows = await repo.listContacts();
    const alice = rows.find((r) => r.jid === "111@s.whatsapp.net");
    expect(alice?.linkedPersonId).toBeTruthy();
    expect(alice?.linkedPersonName).toBe("Alice Smith");
  });

  it("stores messages and surfaces the latest preview + count on the contact", async () => {
    await repo.upsertContacts([{ jid: "111@s.whatsapp.net", name: "Alice" }]);
    await repo.upsertMessages([
      {
        id: "m1",
        chatJid: "111@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_000_000),
        type: "text",
        text: "first",
        hasMedia: false,
      },
      {
        id: "m2",
        chatJid: "111@s.whatsapp.net",
        fromMe: true,
        timestamp: new Date(1_700_000_100_000),
        type: "text",
        text: "latest reply",
        hasMedia: false,
      },
    ]);

    const rows = await repo.listContacts();
    const alice = rows.find((r) => r.jid === "111@s.whatsapp.net");
    expect(alice?.messageCount).toBe(2);
    expect(alice?.lastMessagePreview).toBe("latest reply");
    expect(alice?.lastMessageAt).toBe(Math.floor(1_700_000_100_000 / 1000));
  });

  it("returns messages oldest→newest and ignores duplicate ids", async () => {
    await repo.upsertContacts([{ jid: "222@s.whatsapp.net", phoneNumber: "222", name: "Bob" }]);
    await repo.upsertMessages([
      {
        id: "m2",
        chatJid: "111@s.whatsapp.net",
        fromMe: true,
        timestamp: new Date(1_700_000_100_000),
        text: "second",
        hasMedia: false,
      },
      {
        id: "m1",
        chatJid: "111@s.whatsapp.net",
        senderJid: "222@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_000_000),
        text: "first",
        hasMedia: false,
      },
    ]);
    // Duplicate id is ignored (messages are immutable).
    await repo.upsertMessages([
      {
        id: "m1",
        chatJid: "111@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_000_000),
        text: "first EDITED",
        hasMedia: false,
      },
    ]);

    const msgs = await repo.getMessages("111@s.whatsapp.net");
    expect(msgs.map((m) => m.text)).toEqual(["first", "second"]);
    expect(msgs[0].fromMe).toBe(false);
    expect(msgs[0].senderName).toBe("Bob");
    expect(msgs[0].senderPhoneNumber).toBe("222");
    expect(msgs[1].fromMe).toBe(true);
  });

  it("fetches recent history across chats in chronological order", async () => {
    await repo.upsertContacts([
      { jid: "111@s.whatsapp.net", phoneNumber: "111", name: "Alice" },
      { jid: "222@s.whatsapp.net", phoneNumber: "222", notify: "Bob" },
    ]);
    await repo.upsertChats([{ jid: "120@g.us", name: "Launch crew", isGroup: true }]);
    await repo.upsertMessages([
      {
        id: "old",
        chatJid: "111@s.whatsapp.net",
        senderJid: "111@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_000_000),
        type: "text",
        text: "too old",
        hasMedia: false,
      },
      {
        id: "m2",
        chatJid: "120@g.us",
        senderJid: "222@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_200_000),
        type: "image",
        text: "diagram",
        hasMedia: true,
        pushName: "Bobby",
      },
      {
        id: "m1",
        chatJid: "111@s.whatsapp.net",
        senderJid: "111@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_100_000),
        type: "text",
        text: "hello",
        hasMedia: false,
      },
    ]);

    const rows = await repo.fetchHistory(null, new Date(1_700_000_050_000));

    expect(rows.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(rows[0]).toMatchObject({
      chatJid: "111@s.whatsapp.net",
      chatName: "Alice",
      chatPhoneNumber: "111",
      senderName: "Alice",
      senderPhoneNumber: "111",
      isGroup: false,
      text: "hello",
    });
    expect(rows[1]).toMatchObject({
      chatJid: "120@g.us",
      chatName: "Launch crew",
      senderName: "Bob",
      senderPhoneNumber: "222",
      isGroup: true,
      type: "image",
      hasMedia: true,
      pushName: "Bobby",
    });
  });

  it("fetches history for a single chat only", async () => {
    await repo.upsertMessages([
      {
        id: "a",
        chatJid: "111@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_100_000),
        text: "keep",
        hasMedia: false,
      },
      {
        id: "b",
        chatJid: "222@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_200_000),
        text: "skip",
        hasMedia: false,
      },
    ]);

    const rows = await repo.fetchHistory("111@s.whatsapp.net", new Date(1_700_000_000_000));

    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("heals a reaction an older sync stored as a contentless row, but leaves other types immutable", async () => {
    // Pre-fix state: the reaction landed as an empty 'other' row; a normal text
    // message is also present.
    await repo.upsertMessages([
      {
        id: "r1",
        chatJid: "111@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_050_000),
        type: "other",
        text: null,
        hasMedia: false,
      },
      {
        id: "m1",
        chatJid: "111@s.whatsapp.net",
        fromMe: true,
        timestamp: new Date(1_700_000_000_000),
        type: "text",
        text: "the original",
        hasMedia: false,
      },
    ]);

    // Re-sync now classifies the same frames correctly.
    await repo.upsertMessages([
      {
        id: "r1",
        chatJid: "111@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_050_000),
        type: "reaction",
        text: "❤️",
        hasMedia: false,
        reactsToId: "m1",
      },
      {
        id: "m1",
        chatJid: "111@s.whatsapp.net",
        fromMe: true,
        timestamp: new Date(1_700_000_000_000),
        type: "text",
        text: "an edit that must NOT land",
        hasMedia: false,
      },
    ]);

    const msgs = await repo.getMessages("111@s.whatsapp.net");
    const reaction = msgs.find((m) => m.id === "r1");
    const text = msgs.find((m) => m.id === "m1");
    expect(reaction).toMatchObject({ type: "reaction", text: "❤️", reactsToId: "m1" });
    expect(text?.text).toBe("the original"); // non-reaction stays immutable
  });

  it("keeps a reaction off the contact preview but returns it with its target", async () => {
    await repo.upsertContacts([{ jid: "111@s.whatsapp.net", name: "Alice" }]);
    await repo.upsertMessages([
      {
        id: "m1",
        chatJid: "111@s.whatsapp.net",
        fromMe: true,
        timestamp: new Date(1_700_000_000_000),
        type: "text",
        text: "nice video",
        hasMedia: false,
      },
      {
        id: "r1",
        chatJid: "111@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_050_000), // newer than the text
        type: "reaction",
        text: "❤️",
        hasMedia: false,
        reactsToId: "m1",
      },
    ]);

    // The reaction is the newest row, but it must not become the last message.
    const rows = await repo.listContacts();
    const alice = rows.find((r) => r.jid === "111@s.whatsapp.net");
    expect(alice?.lastMessagePreview).toBe("nice video");
    expect(alice?.lastMessageAt).toBe(Math.floor(1_700_000_000_000 / 1000));

    // ...but the chat view still gets it, carrying its emoji + target id.
    const msgs = await repo.getMessages("111@s.whatsapp.net");
    const reaction = msgs.find((m) => m.id === "r1");
    expect(reaction).toMatchObject({ type: "reaction", text: "❤️", reactsToId: "m1" });
  });

  it("orders contacts with conversations before silent ones", async () => {
    await repo.upsertContacts([
      { jid: "zzz@s.whatsapp.net", name: "Zeb" }, // silent
      { jid: "aaa@s.whatsapp.net", name: "Aaron" }, // has a message
    ]);
    await repo.upsertMessages([
      {
        id: "x",
        chatJid: "aaa@s.whatsapp.net",
        fromMe: false,
        timestamp: new Date(1_700_000_000_000),
        text: "hi",
        hasMedia: false,
      },
    ]);

    const rows = await repo.listContacts();
    expect(rows[0].jid).toBe("aaa@s.whatsapp.net"); // conversation first
    expect(rows[1].jid).toBe("zzz@s.whatsapp.net");
  });
});
