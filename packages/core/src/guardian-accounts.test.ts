// Seam under test: People's run-time links to the guardian, told to Access's
// step the way index.ts wires them, observed through `roleOfAccount`.

import { afterEach, describe, expect, it } from "@rstest/core";
import {
  guardianAccountLinked,
  guardianSeatCreated,
  memberContext,
  roleOfAccount,
} from "./access/application/members.js";
import { linkGuardianToAccount, type GuardianLinked } from "./people/guardian-mapping.js";
import { DrizzlePeopleRepository } from "./people/infrastructure/drizzle-people-repository.js";
import { createTestDb, type TestDb } from "./test/db.js";

describe("the guardian's accounts linked while Rome runs", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  async function setup() {
    testDb = createTestDb();
    const ctx = memberContext(testDb.db);
    const people = new DrizzlePeopleRepository(testDb.db);
    await people.createWithId("guardian", { displayName: "Guardian", bondLevel: "guardian" });
    await guardianSeatCreated(ctx, {
      accounts: [{ platform: "rome-cloud-email", accountId: "owner@example.com" }],
    });
    const linked: GuardianLinked = (account) =>
      guardianAccountLinked(ctx, { platform: account.platform, accountId: account.id });
    return { ctx, people, linked };
  }

  it("answers guardian for an account People links, without a restart", async () => {
    const { ctx, people, linked } = await setup();

    await linkGuardianToAccount(people, "whatsapp", "15551234567@s.whatsapp.net", { linked });
    await linkGuardianToAccount(people, "email", "Owner@Example.com", { linked });

    expect(
      await roleOfAccount(ctx, { platform: "whatsapp", accountId: "15551234567@s.whatsapp.net" }),
    ).toBe("guardian");
    expect(await roleOfAccount(ctx, { platform: "email", accountId: "owner@example.com" })).toBe(
      "guardian",
    );
  });
});
