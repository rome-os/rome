import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { AccountProfilesRepository } from "./account-profiles.js";

const ADA = { platform: "telegram", id: "1001" };
const GRACE = { platform: "telegram", id: "1002" };

describe("AccountProfilesRepository", () => {
  let testDb: TestDb;
  let repo: AccountProfilesRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new AccountProfilesRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("answers positionally, with null for an account it has not learned", async () => {
    await repo.fromMessage(ADA, { displayName: "Ada", handle: "ada", avatarUrl: null });

    expect(await repo.profilesOf([GRACE, ADA])).toEqual([
      null,
      { displayName: "Ada", handle: "ada", avatarUrl: null },
    ]);
  });

  it("keys by platform and id, so one id on two platforms is two accounts", async () => {
    await repo.fromMessage(ADA, { displayName: "Ada", handle: null, avatarUrl: null });

    const [onSlack] = await repo.profilesOf([{ platform: "slack", id: ADA.id }]);
    expect(onSlack).toBeNull();
  });

  it("takes a newer message's name, and keeps what the newer message left out", async () => {
    await repo.fromMessage(ADA, { displayName: "Ada", handle: "ada", avatarUrl: null });
    await repo.fromMessage(ADA, { displayName: "Ada L.", handle: null, avatarUrl: null });

    const [profile] = await repo.profilesOf([ADA]);
    expect(profile).toEqual({ displayName: "Ada L.", handle: "ada", avatarUrl: null });
  });

  it("lets an address book replace a message's row, and never the reverse", async () => {
    await repo.fromMessage(ADA, { displayName: "ada99", handle: "ada", avatarUrl: null });
    await repo.fromAddressBook([
      { account: ADA, displayName: "Ada Lovelace", handle: null, avatarUrl: null },
    ]);
    await repo.fromMessage(ADA, { displayName: "ada2000", handle: "ada2", avatarUrl: null });

    const [profile] = await repo.profilesOf([ADA]);
    expect(profile).toEqual({ displayName: "Ada Lovelace", handle: null, avatarUrl: null });
  });

  it("writes and reads an address book larger than one batch", async () => {
    const accounts = Array.from({ length: 450 }, (_, i) => ({ platform: "whatsapp", id: `${i}` }));
    await repo.fromAddressBook(
      accounts.map((account) => ({
        account,
        displayName: `Contact ${account.id}`,
        handle: null,
        avatarUrl: null,
      })),
    );

    const profiles = await repo.profilesOf(accounts);
    expect(profiles.map((profile) => profile?.displayName)).toEqual(
      accounts.map((account) => `Contact ${account.id}`),
    );
  });
});
