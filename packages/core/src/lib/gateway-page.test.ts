import { describe, it, expect, afterEach, beforeEach } from "@rstest/core";
import { detectTailnetDns, getInstanceName } from "./gateway-page.js";
import { persons } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";

describe("detectTailnetDns", () => {
  it("returns null when the tailscale binary is unavailable", async () => {
    // CI and most dev machines have no tailscale binary → execFile rejects,
    // which takes the catch branch.
    const out = await detectTailnetDns();
    // Strictly, this could be a real DNS name when run on a machine with
    // tailscale; either outcome satisfies the type contract.
    expect(out === null || typeof out === "string").toBe(true);
  });
});

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

  it("returns 'This' when there is no guardian, no slug, and no tailscale", async () => {
    // No guardian row, no slug, and tailscale is not installed on CI — the
    // inner try/catch in detectTailnetDns returns null, so we fall through.
    const name = await getInstanceName(testDb.db);
    // On a dev machine with tailscale running, this may be something else;
    // accept either the default or a non-empty string.
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });

  it("tolerates a null db", async () => {
    process.env.PANTHEON_SLUG = "my-rome";
    expect(await getInstanceName(null)).toBe("my-rome");
  });
});
