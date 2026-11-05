import { describe, it, expect, afterEach, beforeEach } from "@rstest/core";
import { getInstanceName } from "./gateway-page.js";
import { persons } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";

describe("getInstanceName", () => {
  let testDb: TestDb;
  const originalSlug = process.env.PANTHEON_SLUG;

  beforeEach(() => {
    testDb = createTestDb();
    delete process.env.PANTHEON_SLUG;
  });

  afterEach(() => {
    testDb.close();
    if (originalSlug === undefined) delete process.env.PANTHEON_SLUG;
    else process.env.PANTHEON_SLUG = originalSlug;
  });

  it("prefers the guardian person's displayName when one exists", async () => {
    await testDb.db.insert(persons).values({
      id: "p1",
      displayName: "Alice",
      bondLevel: "guardian",
      createdAt: new Date(),
    });
    expect(await getInstanceName(testDb.db)).toBe("Alice");
  });

  it("falls back to PANTHEON_SLUG when no guardian row is present", async () => {
    process.env.PANTHEON_SLUG = "my-rome";
    expect(await getInstanceName(testDb.db)).toBe("my-rome");
  });

  it("returns 'This' when there is no guardian and no slug", async () => {
    expect(await getInstanceName(testDb.db)).toBe("This");
  });

  it("tolerates a null db", async () => {
    process.env.PANTHEON_SLUG = "my-rome";
    expect(await getInstanceName(null)).toBe("my-rome");
  });
});
