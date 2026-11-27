// The guardian's accounts an app reads through `ctx.access`, as the host
// builds it: who the guardian is from Access, their accounts from Identity.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import { peopleLinkChanged } from "./access/application/guardian-links.js";
import { guardianSeatCreated, memberContext, seatAccounts } from "./access/application/members.js";
import { appAccess } from "./apps/app-access-port.js";
import { links, persons } from "./db/schema.js";
import {
  accountCodeContext,
  accountCodeIssued,
  accountCodeRedeemed,
} from "./identity/application/account-codes.js";
import { createIdentity } from "./identity/identity.js";
import { DrizzlePeopleRepository } from "./people/infrastructure/drizzle-people-repository.js";
import { createTestDb, type TestDb } from "./test/db.js";

const SIGN_IN = { platform: "rome-cloud-email", id: "owner@example.com" };
// The mail account the sign-in gives.
const MAIL = { platform: "email", id: "owner@example.com" };

describe("the guardian's accounts as apps read them", () => {
  let testDb: TestDb;
  let people: DrizzlePeopleRepository;
  let guardianId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    const { db } = testDb;
    people = new DrizzlePeopleRepository(db, (change) => peopleLinkChanged(db, change));
    db.insert(persons)
      .values({ id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: new Date() })
      .run();
    const seat = { accounts: seatAccounts({ email: SIGN_IN.id }) };
    guardianId = (await guardianSeatCreated(memberContext(db), seat)).id;
  });
  afterEach(() => testDb.close());

  const guardianAccounts = () => appAccess(testDb.db).guardianAccounts();

  it("answers the guardian's accounts on two platforms, also once People's rows for them are gone", async () => {
    people.linkStated({ platform: "slack", id: "T1/U1" }, "owner");
    people.linkStated({ platform: "telegram", id: "42" }, "owner");
    const [before] = await people.byBondLevel("guardian");
    const today = [...before.links.map(({ platform, id }) => ({ platform, id })), SIGN_IN, MAIL];

    expect(await guardianAccounts()).toEqual(expect.arrayContaining(today));
    expect(await guardianAccounts()).toHaveLength(today.length);

    testDb.db.delete(links).where(eq(links.personId, "owner")).run();
    expect(await guardianAccounts()).toEqual(expect.arrayContaining(today));
  });

  it("answers an account added with a code and an agent's account", async () => {
    const codes = accountCodeContext(testDb.db);
    const { code } = await accountCodeIssued(codes, guardianId);
    await accountCodeRedeemed(codes, code, { platform: "discord", accountId: "d-7" });
    people.linkDelegate({ platform: "agents", id: "ep-atlas" }, "owner");

    expect(await guardianAccounts()).toEqual(
      expect.arrayContaining([
        { platform: "discord", id: "d-7" },
        { platform: "agents", id: "ep-atlas" },
      ]),
    );
  });

  it("puts the account given last first, so a stale id on the same platform does not win", async () => {
    const identity = createIdentity(testDb.db);
    await identity.addAccount(guardianId, { platform: "wechat", accountId: "wx-1-old" });
    await identity.addAccount(guardianId, { platform: "wechat", accountId: "wx-2-new" });

    const wechat = (await guardianAccounts()).find((account) => account.platform === "wechat");
    expect(wechat).toEqual({ platform: "wechat", id: "wx-2-new" });
  });

  it("answers no accounts while Rome has no guardian", async () => {
    const empty = createTestDb();
    expect(await appAccess(empty.db).guardianAccounts()).toEqual([]);
    empty.close();
  });
});
