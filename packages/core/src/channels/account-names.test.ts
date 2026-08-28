import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { LinkedInStoreRepository } from "../db/repositories/linkedin-store.js";
import { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import { WhatsAppStoreRepository } from "../db/repositories/whatsapp-store.js";
import { AccountNames, createAccountNames } from "./account-names.js";
import type { AccountId } from "./accounts.js";
import { LinkedInAccounts } from "./linkedin-accounts.js";
import { WhatsAppAccounts } from "./whatsapp-accounts.js";

const PHONE = "15550007777@s.whatsapp.net";
const LID = "88817260077@lid";
const NAMELESS = "15550001111@s.whatsapp.net";
const MEMBER = "ACoAAAda0001";

const sentinelMessage = (
  channel: string,
  channelUserId: string,
  displayName: string | undefined,
) => ({
  messageId: `${channel}-${channelUserId}-${displayName ?? "anon"}`,
  channel,
  channelUserId,
  displayName,
  text: "hello",
  action: "escalated" as const,
});

describe("AccountNames", () => {
  let testDb: TestDb;
  let whatsAppStore: WhatsAppStoreRepository;
  let linkedInStore: LinkedInStoreRepository;
  let sentinelLogRepo: SentinelLogRepository;
  let names: AccountNames;

  beforeEach(async () => {
    testDb = createTestDb();
    whatsAppStore = new WhatsAppStoreRepository(testDb.db);
    linkedInStore = new LinkedInStoreRepository(testDb.db);
    sentinelLogRepo = new SentinelLogRepository(testDb.db);
    names = createAccountNames({
      whatsAppAccounts: new WhatsAppAccounts(whatsAppStore),
      linkedInAccounts: new LinkedInAccounts(linkedInStore),
      sentinelLogRepo,
    });

    await whatsAppStore.upsertContacts([
      { jid: PHONE, phoneNumber: "15550007777", name: "Ada Lovelace" },
      { jid: LID, phoneNumber: "15550007777" },
      { jid: NAMELESS, phoneNumber: "15550001111", name: "", notify: "", verifiedName: "" },
    ]);
    await linkedInStore.upsertThreads([
      {
        threadId: "t1",
        threadUrl: "https://www.linkedin.com/messaging/thread/t1/",
        personName: "Grace Hopper",
        unread: false,
      },
    ]);
    await linkedInStore.upsertThreadParticipants("t1", [
      {
        participantId: MEMBER,
        name: "Grace Hopper",
        headline: "Rear Admiral",
        type: "member",
        isSelf: false,
      },
    ]);
    await sentinelLogRepo.create(sentinelMessage("telegram", "5512345", "Alan T"));
  });

  afterEach(() => testDb.close());

  it("names an account on every channel through one call", async () => {
    expect(await names.displayName("whatsapp", PHONE)).toBe("Ada Lovelace");
    expect(await names.displayName("linkedin", MEMBER)).toBe("Grace Hopper");
    expect(await names.displayName("telegram", "5512345")).toBe("Alan T");
  });

  it("answers the same name to every address the channel folds together", async () => {
    expect(await names.displayName("whatsapp", LID)).toBe("Ada Lovelace");
  });

  it("falls back to the raw identifier when nothing holds a name", async () => {
    expect(await names.displayName("whatsapp", NAMELESS)).toBe(NAMELESS);
    expect(await names.displayName("whatsapp", "15559999999@s.whatsapp.net")).toBe(
      "15559999999@s.whatsapp.net",
    );
    expect(await names.displayName("telegram", "5599999")).toBe("5599999");
  });

  it("takes the name a sender sent when the mirror holds none, and never over one", async () => {
    await sentinelLogRepo.create(sentinelMessage("whatsapp", NAMELESS, "Bobby"));
    await sentinelLogRepo.create(sentinelMessage("whatsapp", PHONE, "Ada on her phone"));

    expect(await names.displayName("whatsapp", NAMELESS)).toBe("Bobby");
    expect(await names.displayName("whatsapp", PHONE)).toBe("Ada Lovelace");
  });

  it("keeps the last name a sender gave when a later message carried none", async () => {
    await sentinelLogRepo.create(sentinelMessage("telegram", "5512345", undefined));

    expect(await names.displayName("telegram", "5512345")).toBe("Alan T");
  });

  it("names a listing in the order asked", async () => {
    expect(
      await names.displayNames([
        { channel: "telegram", channelUserId: "5512345" },
        { channel: "whatsapp", channelUserId: LID },
        { channel: "whatsapp", channelUserId: NAMELESS },
      ]),
    ).toEqual(["Alan T", "Ada Lovelace", NAMELESS]);
  });

  it("takes a new provider as one address book, with no change to the call", async () => {
    const matrix = {
      resolve: async (identifier: string) =>
        identifier === "@ada:matrix.org"
          ? {
              id: identifier as AccountId,
              addresses: [identifier],
              name: "Ada on Matrix",
              identifiers: {},
            }
          : null,
    };
    const withMatrix = new AccountNames({ matrix }, { listLatestDisplayNames: async () => [] });

    expect(await withMatrix.displayName("matrix", "@ada:matrix.org")).toBe("Ada on Matrix");
    expect(await withMatrix.displayName("matrix", "@grace:matrix.org")).toBe("@grace:matrix.org");
  });
});
