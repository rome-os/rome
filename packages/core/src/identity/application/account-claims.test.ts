import { afterEach, describe, expect, it } from "@rstest/core";
import { accountClaims } from "../../db/schema.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { AccountTakenError, createIdentity, UnknownPersonError } from "../identity.js";
import {
  accountClaimConfirmed,
  accountClaimOf,
  accountClaimStarted,
  CLAIM_LIFETIME_MS,
  ClaimExpiredError,
  claimContext,
  ClaimUsedError,
  UnknownClaimError,
} from "./account-claims.js";

const ANN_SLACK = { platform: "slack", accountId: "T1:U7" };

describe("account claims", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function setup() {
    testDb = createTestDb();
    const clock = { now: new Date("2026-11-25T10:00:00Z") };
    const ctx = claimContext(testDb.db, () => clock.now);
    const identity = createIdentity(testDb.db);
    const later = (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    };
    return { db: testDb.db, ctx, identity, later };
  }

  it("adds the claim's account to the person who confirms it", async () => {
    const { ctx, identity } = setup();
    const ann = await identity.createPerson({ accounts: [] });

    const { token, expiresAt } = await accountClaimStarted(ctx, ANN_SLACK);

    expect(expiresAt).toEqual(new Date(Date.parse("2026-11-25T10:00:00Z") + CLAIM_LIFETIME_MS));
    expect(await accountClaimOf(ctx, token)).toEqual({ account: ANN_SLACK, expiresAt });
    expect(await accountClaimConfirmed(ctx, token, ann.id)).toEqual(ANN_SLACK);
    expect((await identity.personOf(ANN_SLACK))?.id).toBe(ann.id);
  });

  it("changes nothing when the claim is only opened", async () => {
    const { db, ctx, identity } = setup();
    const { token } = await accountClaimStarted(ctx, ANN_SLACK);
    const before = db.select().from(accountClaims).all();

    await accountClaimOf(ctx, token);
    await accountClaimOf(ctx, token);

    expect(db.select().from(accountClaims).all()).toEqual(before);
    expect(await identity.personOf(ANN_SLACK)).toBeNull();
  });

  it("stores a hash of the token and never the token", async () => {
    const { db, ctx } = setup();
    const { token } = await accountClaimStarted(ctx, ANN_SLACK);

    const rows = db.select().from(accountClaims).all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(Buffer.from(token, "base64url").length).toBeGreaterThanOrEqual(16);
  });

  it("refuses an expired claim and changes nothing", async () => {
    const { ctx, identity, later } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const { token } = await accountClaimStarted(ctx, ANN_SLACK);

    later(CLAIM_LIFETIME_MS);

    expect(await accountClaimOf(ctx, token)).toBeNull();
    await expect(accountClaimConfirmed(ctx, token, ann.id)).rejects.toBeInstanceOf(
      ClaimExpiredError,
    );
    expect(await identity.personOf(ANN_SLACK)).toBeNull();
  });

  it("refuses a claim confirmed once already", async () => {
    const { ctx, identity } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const bob = await identity.createPerson({ accounts: [] });
    const { token } = await accountClaimStarted(ctx, ANN_SLACK);
    await accountClaimConfirmed(ctx, token, ann.id);

    expect(await accountClaimOf(ctx, token)).toBeNull();
    await expect(accountClaimConfirmed(ctx, token, bob.id)).rejects.toBeInstanceOf(ClaimUsedError);
    expect((await identity.personOf(ANN_SLACK))?.id).toBe(ann.id);
    expect(await identity.accountsOf(bob.id)).toEqual([]);
  });

  it("refuses a token no claim has and changes nothing", async () => {
    const { ctx, identity } = setup();
    const ann = await identity.createPerson({ accounts: [] });

    expect(await accountClaimOf(ctx, "no-such-token")).toBeNull();
    await expect(accountClaimConfirmed(ctx, "no-such-token", ann.id)).rejects.toBeInstanceOf(
      UnknownClaimError,
    );
    expect(await identity.accountsOf(ann.id)).toEqual([]);
  });

  it("refuses a person Rome does not know and leaves the claim open", async () => {
    const { ctx, identity } = setup();
    const { token } = await accountClaimStarted(ctx, ANN_SLACK);

    await expect(accountClaimConfirmed(ctx, token, "no-such-person")).rejects.toBeInstanceOf(
      UnknownPersonError,
    );
    expect(await identity.personOf(ANN_SLACK)).toBeNull();
    expect(await accountClaimOf(ctx, token)).not.toBeNull();
  });

  it("replaces the first claim on an account when a second starts", async () => {
    const { db, ctx, identity } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const first = await accountClaimStarted(ctx, ANN_SLACK);
    const second = await accountClaimStarted(ctx, ANN_SLACK);

    expect(db.select().from(accountClaims).all()).toHaveLength(1);
    expect(await accountClaimOf(ctx, first.token)).toBeNull();
    await expect(accountClaimConfirmed(ctx, first.token, ann.id)).rejects.toBeInstanceOf(
      UnknownClaimError,
    );
    expect(await accountClaimConfirmed(ctx, second.token, ann.id)).toEqual(ANN_SLACK);
  });

  it("refuses to start a claim on an account a person holds", async () => {
    const { db, ctx, identity } = setup();
    await identity.createPerson({ accounts: [ANN_SLACK] });

    await expect(accountClaimStarted(ctx, ANN_SLACK)).rejects.toBeInstanceOf(AccountTakenError);
    expect(db.select().from(accountClaims).all()).toEqual([]);
  });

  it("refuses to confirm when someone took the account after the claim started", async () => {
    const { ctx, identity } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const { token } = await accountClaimStarted(ctx, ANN_SLACK);
    const bob = await identity.createPerson({ accounts: [ANN_SLACK] });

    await expect(accountClaimConfirmed(ctx, token, ann.id)).rejects.toBeInstanceOf(
      AccountTakenError,
    );
    expect((await identity.personOf(ANN_SLACK))?.id).toBe(bob.id);
    expect(await identity.accountsOf(ann.id)).toEqual([]);
    expect(await accountClaimOf(ctx, token)).not.toBeNull();
  });

  it("succeeds for the person who already holds the account and changes nothing else", async () => {
    const { ctx, identity } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const { token } = await accountClaimStarted(ctx, ANN_SLACK);
    await identity.addAccount(ann.id, ANN_SLACK);

    expect(await accountClaimConfirmed(ctx, token, ann.id)).toEqual(ANN_SLACK);
    expect(await identity.accountsOf(ann.id)).toEqual([ANN_SLACK]);
  });
});
