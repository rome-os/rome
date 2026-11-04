import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { LinkedInStoreRepository } from "../db/repositories/linkedin-store.js";
import { LinkedInAccounts } from "./linkedin-accounts.js";

const ada = {
  participantId: "ACoAAAda0001",
  name: "Ada Lovelace",
  headline: "Engineer",
  type: "member",
  isSelf: false,
};
const grace = {
  participantId: "ACoAAGrace002",
  name: "Grace Hopper",
  headline: "Rear Admiral",
  type: "member",
  isSelf: false,
};
const self = {
  participantId: "ACoAASelf0003",
  name: "Me Myself",
  headline: null,
  type: "member",
  isSelf: true,
};

describe("LinkedInAccounts", () => {
  let testDb: TestDb;
  let repo: LinkedInStoreRepository;
  let accounts: LinkedInAccounts;

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new LinkedInStoreRepository(testDb.db);
    accounts = new LinkedInAccounts(repo);
    await repo.upsertThreads([
      {
        threadId: "t1",
        threadUrl: "https://www.linkedin.com/messaging/thread/t1/",
        personName: "Ada Lovelace",
        unread: false,
      },
    ]);
    await repo.upsertThreadParticipants("t1", [ada, grace, self]);
  });

  afterEach(() => testDb.close());

  it("resolves a profile URL and a bare member id to one account", async () => {
    const fromUrl = await accounts.resolve("https://www.linkedin.com/in/ACoAAAda0001/");
    const fromId = await accounts.resolve("ACoAAAda0001");

    expect(fromUrl).not.toBeNull();
    expect(fromUrl!.id).toBe("ACoAAAda0001");
    expect(fromId!.id).toBe(fromUrl!.id);
    expect((await accounts.resolve(fromUrl!.id))!.id).toBe(fromUrl!.id);
  });

  it("describes an account by name and namespaced identifier", async () => {
    const account = (await accounts.resolve("ACoAAAda0001"))!;

    expect(account.name).toBe("Ada Lovelace");
    expect(account.identifiers).toEqual({ "linkedin:member_id": "ACoAAAda0001" });
  });

  it("excludes the guardian's own row", async () => {
    const page = await accounts.listAccounts({ limit: 50 });

    expect(page.accounts.map((a) => a.id)).toEqual(["ACoAAAda0001", "ACoAAGrace002"]);
    expect(await accounts.resolve("ACoAASelf0003")).toBeNull();
  });

  it("addresses each member by its member id and nothing else", async () => {
    // A member is stored under its member id alone; the profile URL that also
    // names it is derived on sight, so `resolve` takes one and the listing
    // never publishes it as an address.
    const page = await accounts.listAccounts({ limit: 50 });

    expect(page.accounts.map((a) => a.addresses)).toEqual([["ACoAAAda0001"], ["ACoAAGrace002"]]);
  });

  it("returns null for an unknown identifier", async () => {
    expect(await accounts.resolve("ACoAANobody999")).toBeNull();
    expect(await accounts.resolve("https://www.linkedin.com/in/ada-lovelace/")).toBeNull();
    expect(await accounts.resolve("")).toBeNull();
  });

  it("pages and filters by query", async () => {
    const first = await accounts.listAccounts({ limit: 1 });
    expect(first.accounts.map((a) => a.name)).toEqual(["Ada Lovelace"]);
    expect(first.nextCursor).toBeDefined();

    const second = await accounts.listAccounts({ limit: 1, cursor: first.nextCursor });
    expect(second.accounts.map((a) => a.name)).toEqual(["Grace Hopper"]);
    expect(second.nextCursor).toBeUndefined();

    const byName = await accounts.listAccounts({ limit: 50, query: "hopper" });
    expect(byName.accounts.map((a) => a.id)).toEqual(["ACoAAGrace002"]);
  });
});
