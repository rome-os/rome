import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import type { DrizzleDb } from "../db/index.js";
import { WhatsAppStoreRepository } from "../db/repositories/whatsapp-store.js";
import { WhatsAppAccounts } from "./whatsapp-accounts.js";

const PHONE = "15550007777@s.whatsapp.net";
const LID = "88817260077@lid";

const message = (id: string, jid: string, at: string, text: string) => ({
  id,
  chatJid: jid,
  senderJid: jid,
  fromMe: false,
  timestamp: new Date(at),
  type: "text",
  text,
  hasMedia: false,
});

describe("WhatsAppAccounts", () => {
  let db: DrizzleDb;
  let close: () => void;
  let repo: WhatsAppStoreRepository;
  let accounts: WhatsAppAccounts;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    close = t.close;
    repo = new WhatsAppStoreRepository(db);
    accounts = new WhatsAppAccounts(repo);
  });

  afterEach(() => close());

  it("keeps one id when a message lands on the other address", async () => {
    await repo.upsertContacts([
      { jid: PHONE, phoneNumber: "15550007777", name: "One Contact" },
      { jid: LID, phoneNumber: "15550007777", name: "One Contact" },
    ]);
    await repo.upsertMessages([message("a", PHONE, "2026-08-20T10:00:00Z", "on phone")]);
    const before = (await accounts.resolve(PHONE))!.id;

    await repo.upsertMessages([message("b", LID, "2026-08-21T10:00:00Z", "on lid")]);

    expect((await accounts.resolve(PHONE))!.id).toBe(before);
    expect((await accounts.resolve(LID))!.id).toBe(before);
    expect((await accounts.resolve(before))!.id).toBe(before);
  });

  it("folds both addresses into a single account", async () => {
    await repo.upsertContacts([
      { jid: PHONE, phoneNumber: "15550007777", name: "One Contact" },
      { jid: LID, phoneNumber: "15550007777" },
    ]);

    const page = await accounts.listAccounts({ limit: 50 });
    expect(page.accounts).toHaveLength(1);
    expect(page.accounts[0].name).toBe("One Contact");
    expect(page.accounts[0].identifiers).toEqual({
      phone: "15550007777",
      "whatsapp:lid": LID,
    });
  });

  it("folds an address-book row that has not learned its phone number yet", async () => {
    // The store groups on the stored number, so these two rows stay separate
    // cards. They are still one account, and one account is one `Account`.
    await repo.upsertContacts([
      { jid: "15550009999@s.whatsapp.net", name: "Split Contact" },
      { jid: "99900099999@lid", phoneNumber: "15550009999" },
    ]);

    const page = await accounts.listAccounts({ limit: 50 });
    expect(page.accounts).toHaveLength(1);
    expect(page.accounts[0].id).toBe("15550009999@s.whatsapp.net");
    expect(page.accounts[0].name).toBe("Split Contact");
    expect((await accounts.resolve("99900099999@lid"))!.id).toBe("15550009999@s.whatsapp.net");
  });

  it("carries every stored address, and the derived id, on the one account", async () => {
    await repo.upsertContacts([
      { jid: "15550009999@s.whatsapp.net", name: "Split Contact" },
      { jid: "99900099999@lid", phoneNumber: "15550009999" },
    ]);

    // The listing is where a caller learns which addresses fold together, so
    // the account has to carry all of them — the derived id among them, whether
    // or not a row spelled it out.
    const page = await accounts.listAccounts({ limit: 50 });
    expect([...page.accounts[0].addresses].sort()).toEqual([
      "15550009999@s.whatsapp.net",
      "99900099999@lid",
    ]);
  });

  it("holds no name for an unnamed account, and still carries its number", async () => {
    await repo.upsertContacts([{ jid: PHONE, phoneNumber: "15550007777" }]);

    const page = await accounts.listAccounts({ limit: 50 });
    expect(page.accounts[0].name).toBeNull();
    expect(page.accounts[0].identifiers.phone).toBe("15550007777");
  });

  it("answers a listing and a resolve from one read", async () => {
    // The two are joined by the caller — a fold lists the book and resolves the
    // addresses it already holds — so they must describe the same mirror, and a
    // whole directory should not cost a scan per call.
    await repo.upsertContacts([{ jid: PHONE, phoneNumber: "15550007777", name: "One Contact" }]);
    let reads = 0;
    const listContacts = repo.listContacts.bind(repo);
    repo.listContacts = async (opts) => {
      reads += 1;
      return listContacts(opts);
    };

    await Promise.all([accounts.listAccounts({ limit: 50 }), accounts.resolve(PHONE)]);
    expect(reads).toBe(1);

    // The sharing lasts exactly as long as the read: a later caller sees a
    // contact the first two could not have.
    await repo.upsertContacts([{ jid: LID, phoneNumber: "15550008888", name: "Later" }]);
    expect((await accounts.listAccounts({ limit: 50 })).accounts).toHaveLength(2);
  });

  it("resolves a device-suffixed JID and a bare phone number", async () => {
    await repo.upsertContacts([{ jid: PHONE, phoneNumber: "15550007777", name: "One Contact" }]);

    expect((await accounts.resolve("15550007777:7@s.whatsapp.net"))!.id).toBe(PHONE);
    expect((await accounts.resolve("+1 555-000-7777"))!.id).toBe(PHONE);
  });

  it("excludes group chats", async () => {
    await repo.upsertContacts([{ jid: PHONE, phoneNumber: "15550007777", name: "One Contact" }]);
    await repo.upsertChats([{ jid: "12345-67890@g.us", name: "Team", isGroup: true }]);

    const page = await accounts.listAccounts({ limit: 50 });
    expect(page.accounts.map((a) => a.id)).toEqual([PHONE]);
    expect(await accounts.resolve("12345-67890@g.us")).toBeNull();
  });

  it("returns null for an unknown identifier", async () => {
    await repo.upsertContacts([{ jid: PHONE, phoneNumber: "15550007777", name: "One Contact" }]);

    expect(await accounts.resolve("15550001111@s.whatsapp.net")).toBeNull();
    expect(await accounts.resolve("00000000000@lid")).toBeNull();
    expect(await accounts.resolve("")).toBeNull();
  });

  it("answers a limit that is not a number with a page, not a false exhaustion", async () => {
    await repo.upsertContacts([
      { jid: "15550000001@s.whatsapp.net", phoneNumber: "15550000001", name: "Ada" },
      { jid: "15550000002@s.whatsapp.net", phoneNumber: "15550000002", name: "Bea" },
    ]);

    const page = await accounts.listAccounts({ limit: Number.NaN });
    expect(page.accounts.map((a) => a.name)).toEqual(["Ada", "Bea"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("moves a named LID row onto the phone form once the mirror learns the number", async () => {
    // A documented open gap, pinned so the follow-up sees it move rather than
    // trusting an `AccountId` persisted before the number arrived.
    await repo.upsertContacts([{ jid: "named-lid@lid", name: "Lia" }]);
    expect((await accounts.resolve("named-lid@lid"))!.id).toBe("named-lid@lid");

    await repo.upsertContacts([{ jid: "named-lid@lid", phoneNumber: "15551234567" }]);
    expect((await accounts.resolve("named-lid@lid"))!.id).toBe("15551234567@s.whatsapp.net");
  });

  it("pages and filters by query", async () => {
    await repo.upsertContacts([
      { jid: "15550000001@s.whatsapp.net", phoneNumber: "15550000001", name: "Ada" },
      { jid: "15550000002@s.whatsapp.net", phoneNumber: "15550000002", name: "Bea" },
      { jid: "15550000003@s.whatsapp.net", phoneNumber: "15550000003", name: "Cy" },
    ]);

    const first = await accounts.listAccounts({ limit: 2 });
    expect(first.accounts.map((a) => a.name)).toEqual(["Ada", "Bea"]);
    expect(first.nextCursor).toBeDefined();

    const second = await accounts.listAccounts({ limit: 2, cursor: first.nextCursor });
    expect(second.accounts.map((a) => a.name)).toEqual(["Cy"]);
    expect(second.nextCursor).toBeUndefined();

    const byName = await accounts.listAccounts({ limit: 50, query: "be" });
    expect(byName.accounts.map((a) => a.name)).toEqual(["Bea"]);

    const byIdentifier = await accounts.listAccounts({ limit: 50, query: "15550000003" });
    expect(byIdentifier.accounts.map((a) => a.name)).toEqual(["Cy"]);
  });
});
