// The wiring between People's links to the guardian and the guardian's
// accounts in Identity, as index.ts builds it.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { backfillMembers } from "./access/application/backfill-members.js";
import { peopleLinkChanged } from "./access/application/guardian-links.js";
import { guardianSeatCreated, memberContext, seatAccounts } from "./access/application/members.js";
import { guardianAuth, persons, settings } from "./db/schema.js";
import {
  accountCodeContext,
  accountCodeIssued,
  accountCodeRedeemed,
} from "./identity/application/account-codes.js";
import { createIdentity } from "./identity/identity.js";
import { linkGuardianOnConnect, linkGuardianToAccount } from "./people/guardian-mapping.js";
import { DrizzlePeopleRepository } from "./people/infrastructure/drizzle-people-repository.js";
import { createTestDb, type TestDb } from "./test/db.js";

const SEAT_EMAIL = "owner@example.com";

describe("the guardian's links in People reaching Identity", () => {
  let testDb: TestDb;
  let people: DrizzlePeopleRepository;
  let guardianId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    const { db } = testDb;
    people = new DrizzlePeopleRepository(db, (change) => peopleLinkChanged(db, change));
    const now = new Date();
    db.insert(persons)
      .values({ id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: now })
      .run();
    db.insert(guardianAuth)
      .values({ id: "seat", userId: "u", passwordHash: "x", email: SEAT_EMAIL, createdAt: now })
      .run();
    guardianId = (
      await guardianSeatCreated(memberContext(db), {
        accounts: seatAccounts({ email: SEAT_EMAIL }),
      })
    ).id;
  });
  afterEach(() => testDb.close());

  /** The guardian's accounts in Identity, other than the seat's sign-in. */
  async function inIdentity(): Promise<string[]> {
    const accounts = await createIdentity(testDb.db).accountsOf(guardianId);
    return accounts
      .filter((a) => a.platform !== "rome-cloud-email")
      .map((a) => `${a.platform}:${a.accountId}`);
  }

  async function connect(platform: string, id: string, stableId = false): Promise<void> {
    const apply = await linkGuardianOnConnect(people).prepare({
      platform,
      connectedBy: { id, stableId },
    });
    testDb.db.transaction((tx) => apply?.(tx, { reachesAnotherAccount: false }));
  }

  it("follows a connect, a re-point, a WhatsApp self link and an unlink, and leaves a code's account", async () => {
    const { code } = await accountCodeIssued(accountCodeContext(testDb.db), guardianId);
    await accountCodeRedeemed(accountCodeContext(testDb.db), code, {
      platform: "telegram",
      accountId: "99",
    });

    await connect("wechat", "wx-old");
    expect(await inIdentity()).toEqual(["telegram:99", "wechat:wx-old"]);

    // A kind whose ids are not stable re-points the guardian's one link there.
    await connect("wechat", "wx-new");
    expect(await inIdentity()).toEqual(["telegram:99", "wechat:wx-new"]);

    await linkGuardianToAccount(people, "whatsapp", "15550001@s.whatsapp.net");
    expect(await inIdentity()).toEqual([
      "telegram:99",
      "wechat:wx-new",
      "whatsapp:15550001@s.whatsapp.net",
    ]);

    await people.unlink({ platform: "wechat", id: "wx-new" });
    expect(await inIdentity()).toEqual(["telegram:99", "whatsapp:15550001@s.whatsapp.net"]);

    await backfillMembers(testDb.db);
    expect(await inIdentity()).toEqual(["telegram:99", "whatsapp:15550001@s.whatsapp.net"]);
  });

  it("never gives the guardian a delegate link or a Rome Cloud id", async () => {
    people.linkDelegate({ platform: "agents", id: "ep-atlas" }, "owner");
    people.linkStated({ platform: "rome-cloud", id: "acct-owner" }, "owner");
    people.linkStated({ platform: "slack", id: "T1:U1" }, "owner");
    // Marking the guardian's own link a delegate link takes it from the guardian.
    people.linkDelegate({ platform: "slack", id: "T1:U1" }, "owner");
    expect(await inIdentity()).toEqual([]);
  });

  it("rolls the connect back, credential and link, when Identity cannot be written", async () => {
    const failing = new DrizzlePeopleRepository(testDb.db, () => {
      throw new Error("identity write failed");
    });
    const apply = await linkGuardianOnConnect(failing).prepare({
      platform: "wechat",
      connectedBy: { id: "wx-1" },
    });
    expect(() =>
      testDb.db.transaction((tx) => {
        // Stands in for the credential the grant writes in this transaction.
        tx.insert(settings).values({ key: "credential", value: 1, updatedAt: new Date() }).run();
        apply?.(tx, { reachesAnotherAccount: false });
      }),
    ).toThrow("identity write failed");
    expect(testDb.db.select().from(settings).all()).toEqual([]);
    expect(await people.byAccount({ platform: "wechat", id: "wx-1" })).toBeNull();
  });
});
