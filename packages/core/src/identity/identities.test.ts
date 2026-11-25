import { afterEach, describe, expect, it } from "@rstest/core";
import { identities } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { AccountTakenError, createIdentities } from "./identities.js";

const ANN_SLACK = { platform: "slack", accountId: "T1:U1" };
const ANN_EMAIL = { platform: "email", accountId: "ann@example.com" };

describe("Identities", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function setup() {
    testDb = createTestDb();
    return { db: testDb.db, identity: createIdentities(testDb.db) };
  }

  it("resolves a claimed account to its person and an unclaimed one to nobody", async () => {
    const { identity } = setup();
    const ann = await identity.create({ name: "Ann", accounts: [ANN_SLACK] });

    expect(await identity.personOf(ANN_SLACK)).toEqual({
      id: ann.id,
      name: "Ann",
      avatarUrl: null,
    });
    expect(await identity.personOf({ platform: "slack", accountId: "T1:U2" })).toBeNull();
  });

  it("treats the same account id on two platforms as two accounts", async () => {
    const { identity } = setup();
    const ann = await identity.create({ accounts: [{ platform: "slack", accountId: "42" }] });
    const bob = await identity.create({ accounts: [{ platform: "discord", accountId: "42" }] });

    expect((await identity.personOf({ platform: "slack", accountId: "42" }))?.id).toBe(ann.id);
    expect((await identity.personOf({ platform: "discord", accountId: "42" }))?.id).toBe(bob.id);
  });

  it("rejects an account that belongs to another person and changes nothing", async () => {
    const { identity } = setup();
    const ann = await identity.create({ accounts: [ANN_SLACK] });
    const bob = await identity.create({ accounts: [] });

    await expect(identity.addAccount(bob.id, ANN_SLACK)).rejects.toBeInstanceOf(AccountTakenError);
    expect((await identity.personOf(ANN_SLACK))?.id).toBe(ann.id);
    expect(await identity.accountsOf(bob.id)).toEqual([]);
  });

  it("accepts an account given again to the person who holds it", async () => {
    const { identity } = setup();
    const ann = await identity.create({ accounts: [ANN_SLACK] });

    await identity.addAccount(ann.id, ANN_SLACK);
    await identity.addAccount(ann.id, ANN_EMAIL);

    expect(await identity.accountsOf(ann.id)).toEqual([ANN_EMAIL, ANN_SLACK]);
  });

  it("deletes a person's accounts with them, freeing the accounts for someone else", async () => {
    const { identity } = setup();
    const ann = await identity.create({ accounts: [ANN_SLACK, ANN_EMAIL] });

    await identity.delete(ann.id);

    expect(await identity.personOf(ANN_SLACK)).toBeNull();
    expect(await identity.accountsOf(ann.id)).toEqual([]);
    const bob = await identity.create({ accounts: [ANN_SLACK] });
    expect((await identity.personOf(ANN_SLACK))?.id).toBe(bob.id);
  });

  it("creates nothing when one of the new person's accounts is taken", async () => {
    const { db, identity } = setup();
    await identity.create({ accounts: [ANN_SLACK] });
    const free = { platform: "slack", accountId: "T1:U9" };

    await expect(
      identity.create({ name: "Bob", accounts: [free, ANN_SLACK] }),
    ).rejects.toBeInstanceOf(AccountTakenError);

    expect(db.select().from(identities).all()).toHaveLength(1);
    expect(await identity.personOf(free)).toBeNull();
  });

  it("stores an email trimmed and lowercased, so one address is one account", async () => {
    const { identity } = setup();
    const ann = await identity.create({
      accounts: [{ platform: "email", accountId: "  Ann@Example.COM " }],
    });

    expect(await identity.accountsOf(ann.id)).toEqual([ANN_EMAIL]);
    expect((await identity.personOf({ platform: "email", accountId: "ANN@example.com" }))?.id).toBe(
      ann.id,
    );
  });

  it("removes one account and changes a person's name and avatar", async () => {
    const { identity } = setup();
    const ann = await identity.create({ name: "Ann", accounts: [ANN_SLACK, ANN_EMAIL] });

    await identity.removeAccount(ANN_SLACK);
    await identity.update(ann.id, { avatarUrl: "https://example.com/ann.png" });
    await identity.update(ann.id, { name: null });

    expect(await identity.personOf(ANN_SLACK)).toBeNull();
    expect(await identity.personOf(ANN_EMAIL)).toEqual({
      id: ann.id,
      name: null,
      avatarUrl: "https://example.com/ann.png",
    });
  });
});
