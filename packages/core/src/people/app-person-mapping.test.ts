import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb, identityConnectionKindOf } from "../test/helpers.js";
import { PeopleRepository } from "../db/repositories/people.js";
import { appPersonMapping, type AppPersonMapping } from "./app-person-mapping.js";

describe("appPersonMapping", () => {
  let testDb: TestDb;
  let people: PeopleRepository;
  let app: AppPersonMapping;

  beforeEach(() => {
    testDb = createTestDb();
    people = new PeopleRepository(testDb.db, identityConnectionKindOf);
    app = appPersonMapping(people);
  });

  afterEach(() => {
    testDb.close();
  });

  it("answers apps with the SDK's channelMappings field", async () => {
    const id = await app.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
      channelMappings: [{ channel: "telegram", channelUserId: "tg-alice" }],
    });
    await app.addChannelMapping(id, "whatsapp", "wa-alice");

    const found = await app.findByChannelUser("whatsapp", "wa-alice");

    expect(found?.id).toBe(id);
    expect(found?.channelMappings).toEqual(
      expect.arrayContaining([
        { channel: "telegram", channelUserId: "tg-alice" },
        { channel: "whatsapp", channelUserId: "wa-alice" },
      ]),
    );
    expect(found).not.toHaveProperty("links");
    expect((await app.findByNameFuzzy("alice"))?.id).toBe(id);
    expect((await app.findByName("Alice")).map((person) => person.id)).toEqual([id]);
    expect(await app.findByBondLevel("guardian")).toEqual([]);
  });

  it("answers null for an account nobody holds", async () => {
    expect(await app.findByChannelUser("telegram", "tg-nobody")).toBeNull();
  });
});
