import { afterEach, describe, expect, it } from "@rstest/core";
import { identities, members } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { createAccess, GuardianRemovalError, GuardianTakenError } from "./access.js";

describe("Access", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  // A role row names a person row, so each test seeds the persons it uses.
  function setup(...personIds: string[]) {
    testDb = createTestDb();
    for (const id of personIds) {
      testDb.db.insert(identities).values({ id, createdAt: new Date() }).run();
    }
    return { db: testDb.db, access: createAccess(testDb.db) };
  }

  it("answers each person's role, and null for a person with none", async () => {
    const { access } = setup("owner", "ada", "zed");
    await access.grant("owner", "guardian");
    await access.grant("ada", "member");

    expect(await access.roleOf("owner")).toBe("guardian");
    expect(await access.roleOf("ada")).toBe("member");
    expect(await access.roleOf("zed")).toBeNull();
    expect(await access.roleOf("nobody")).toBeNull();
  });

  it("lists the guardian first, then members in the order they were granted", async () => {
    const { access } = setup("owner", "ada", "lin");
    await access.grant("ada", "member");
    await access.grant("lin", "member");
    await access.grant("owner", "guardian");

    expect(await access.members()).toEqual([
      { personId: "owner", role: "guardian" },
      { personId: "ada", role: "member" },
      { personId: "lin", role: "member" },
    ]);
  });

  it("refuses a second guardian with a named error and changes nothing", async () => {
    const { access } = setup("owner", "ada");
    await access.grant("owner", "guardian");
    await access.grant("ada", "member");

    await expect(access.grant("ada", "guardian")).rejects.toBeInstanceOf(GuardianTakenError);
    expect(await access.members()).toEqual([
      { personId: "owner", role: "guardian" },
      { personId: "ada", role: "member" },
    ]);
  });

  it("changes nothing when the guardian is granted guardian again", async () => {
    const { access } = setup("owner");
    await access.grant("owner", "guardian");
    await access.grant("owner", "guardian");

    expect(await access.members()).toEqual([{ personId: "owner", role: "guardian" }]);
  });

  it("never demotes the guardian to member", async () => {
    const { access } = setup("owner");
    await access.grant("owner", "guardian");
    await access.grant("owner", "member");

    expect(await access.roleOf("owner")).toBe("guardian");
  });

  it("changes nothing when a member is granted member again", async () => {
    const { db, access } = setup("ada");
    await access.grant("ada", "member");
    await access.grant("ada", "member");

    expect(db.select().from(members).all()).toHaveLength(1);
    expect(await access.roleOf("ada")).toBe("member");
  });

  it("makes a member the guardian when there is none", async () => {
    const { access } = setup("ada");
    await access.grant("ada", "member");
    await access.grant("ada", "guardian");

    expect(await access.members()).toEqual([{ personId: "ada", role: "guardian" }]);
  });

  it("revokes a member's role", async () => {
    const { access } = setup("ada");
    await access.grant("ada", "member");
    await access.revoke("ada");

    expect(await access.roleOf("ada")).toBeNull();
    expect(await access.members()).toEqual([]);
  });

  it("refuses to revoke the guardian's role and changes nothing", async () => {
    const { access } = setup("owner");
    await access.grant("owner", "guardian");

    await expect(access.revoke("owner")).rejects.toBeInstanceOf(GuardianRemovalError);
    expect(await access.roleOf("owner")).toBe("guardian");
  });

  it("does nothing when revoking a person with no role", async () => {
    const { access } = setup("zed");
    await access.revoke("zed");
    await access.revoke("nobody");

    expect(await access.members()).toEqual([]);
  });

  it("refuses a second guardian row in the table itself", async () => {
    const { db, access } = setup("owner", "other");
    await access.grant("owner", "guardian");

    expect(() =>
      db
        .insert(members)
        .values({ identityId: "other", role: "guardian", createdAt: new Date() })
        .run(),
    ).toThrow();
  });
});
