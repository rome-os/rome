import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { AccountProfilesRepository } from "../db/repositories/account-profiles.js";
import { WhatsAppStoreRepository } from "../db/repositories/whatsapp-store.js";
import { AccountProfiles, refreshingAfter } from "./account-profiles.js";
import { WhatsAppAccounts } from "./whatsapp-accounts.js";

/** Resolves once the background work `refresh` and `heard` start has landed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const on = (platform: string) => ({ platform, id: "rome" });

const inbound = (overrides: Record<string, unknown> = {}) => ({
  account: on("telegram"),
  direction: "inbound" as const,
  senderId: "1001",
  senderDisplayName: "Ada",
  senderUsername: "ada",
  ...overrides,
});

describe("AccountProfiles", () => {
  let testDb: TestDb;
  let repo: AccountProfilesRepository;
  let profiles: AccountProfiles;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new AccountProfilesRepository(testDb.db);
    profiles = new AccountProfiles(repo);
  });

  afterEach(() => {
    testDb.close();
  });

  it("learns a sender under the platform of the account the message arrived on", async () => {
    profiles.heard(inbound());
    profiles.heard(inbound({ account: on("lark"), senderId: "ou_ada" }));
    await settle();

    expect(await profiles.displayNames([{ platform: "telegram", id: "1001" }])).toEqual(["Ada"]);
    expect(await repo.profilesOf([{ platform: "lark", id: "ou_ada" }])).toEqual([
      { displayName: "Ada", handle: "ada", avatarUrl: null },
    ]);
  });

  it("learns nothing from an outbound message, a message with no sender or account, or a blank name", async () => {
    profiles.heard(inbound({ direction: "outbound" }));
    profiles.heard(inbound({ senderId: "" }));
    profiles.heard(inbound({ account: undefined }));
    profiles.heard(inbound({ senderId: "1002", senderDisplayName: "  ", senderUsername: "" }));
    await settle();

    expect(
      await repo.profilesOf([
        { platform: "telegram", id: "1001" },
        { platform: "telegram", id: "1002" },
      ]),
    ).toEqual([null, null]);
  });

  it("takes no name that only echoes the sender's id", async () => {
    profiles.heard(
      inbound({
        senderId: "1001",
        senderDisplayName: "1001",
        senderUsername: undefined,
      }),
    );
    profiles.heard(
      inbound({
        account: on("email"),
        senderId: "unauthenticated:ada@example.com",
        senderDisplayName: "ada@example.com",
        senderUsername: undefined,
      }),
    );
    profiles.heard(
      inbound({
        account: on("wechat"),
        senderId: "wxid_ada@im.wechat",
        senderDisplayName: "wxid_ada",
        senderUsername: undefined,
      }),
    );
    await settle();

    expect(
      await repo.profilesOf([
        { platform: "telegram", id: "1001" },
        { platform: "email", id: "unauthenticated:ada@example.com" },
        { platform: "wechat", id: "wxid_ada@im.wechat" },
      ]),
    ).toEqual([null, null, null]);
  });

  it("keeps a learned name when a later message carries none", async () => {
    profiles.heard(inbound());
    profiles.heard(inbound({ senderDisplayName: undefined, senderUsername: "ada_new" }));
    await settle();

    expect(await repo.profilesOf([{ platform: "telegram", id: "1001" }])).toEqual([
      { displayName: "Ada", handle: "ada_new", avatarUrl: null },
    ]);
  });

  it("copies an address book in, under its platform and the book's own ids", async () => {
    const store = new WhatsAppStoreRepository(testDb.db);
    await store.upsertContacts([
      { jid: "15550007777@s.whatsapp.net", phoneNumber: "15550007777", name: "Ada Lovelace" },
      { jid: "88817260077@lid", phoneNumber: "15550007777" },
    ]);

    profiles.refresh("whatsapp", new WhatsAppAccounts(store));
    await settle();

    expect(
      await repo.profilesOf([{ platform: "whatsapp", id: "15550007777@s.whatsapp.net" }]),
    ).toEqual([{ displayName: "Ada Lovelace", handle: null, avatarUrl: null }]);
  });

  it("learns nothing from a message on a platform an address book fills", async () => {
    const store = new WhatsAppStoreRepository(testDb.db);
    await store.upsertContacts([
      { jid: "15550007777@s.whatsapp.net", phoneNumber: "15550007777", name: "Ada Lovelace" },
      { jid: "88817260077@lid", phoneNumber: "15550007777" },
    ]);
    profiles.refresh("whatsapp", new WhatsAppAccounts(store));
    await settle();

    // The same account, named by its LID alias rather than the book's id.
    profiles.heard(
      inbound({ account: on("whatsapp"), senderId: "88817260077@lid", senderDisplayName: "ada" }),
    );
    await settle();

    expect(
      await repo.profilesOf([
        { platform: "whatsapp", id: "15550007777@s.whatsapp.net" },
        { platform: "whatsapp", id: "88817260077@lid" },
      ]),
    ).toEqual([{ displayName: "Ada Lovelace", handle: null, avatarUrl: null }, null]);
  });

  it("copies once more when a sync lands during a copy, not once per sync", async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const book = {
      listAccounts: async () => {
        reads += 1;
        if (reads === 1) await gate;
        return { accounts: [] };
      },
    };

    profiles.refresh("whatsapp", book);
    profiles.refresh("whatsapp", book);
    profiles.refresh("whatsapp", book);
    release();
    await settle();

    expect(reads).toBe(2);
  });
});

describe("refreshingAfter", () => {
  class Sink {
    written: string[] = [];
    async upsertContacts(names: string[]) {
      this.written.push(...names);
    }
    async upsertMessages(names: string[]) {
      this.written.push(...names);
    }
  }

  it("refreshes after a watched write lands, and not after any other", async () => {
    const sink = new Sink();
    let refreshes = 0;
    const watched = refreshingAfter(sink, ["upsertContacts"], () => {
      refreshes += 1;
    });

    await watched.upsertMessages(["m"]);
    expect(refreshes).toBe(0);
    await watched.upsertContacts(["c"]);
    expect(refreshes).toBe(1);
    expect(sink.written).toEqual(["m", "c"]);
  });

  it("does not refresh after a write that failed", async () => {
    let refreshes = 0;
    const watched = refreshingAfter(
      {
        upsertContacts: async () => {
          throw new Error("disk full");
        },
      },
      ["upsertContacts"],
      () => {
        refreshes += 1;
      },
    );

    await expect(watched.upsertContacts()).rejects.toThrow("disk full");
    expect(refreshes).toBe(0);
  });
});
