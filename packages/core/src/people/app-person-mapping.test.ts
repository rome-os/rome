import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import type { PersonMappingRepository } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { PeopleRepository } from "../db/repositories/people.js";
import { appPersonMapping } from "./app-person-mapping.js";

describe("appPersonMapping", () => {
  let testDb: TestDb;
  let people: PeopleRepository;
  let app: PersonMappingRepository;

  beforeEach(() => {
    testDb = createTestDb();
    people = new PeopleRepository(testDb.db);
    app = appPersonMapping(people);
  });

  afterEach(() => {
    testDb.close();
  });

  it("answers apps with the SDK's channelMappings field, and accounts beside it", async () => {
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
    expect(found?.accounts).toEqual(
      expect.arrayContaining([
        { platform: "telegram", id: "tg-alice" },
        { platform: "whatsapp", id: "wa-alice" },
      ]),
    );
    expect(found).not.toHaveProperty("links");
    expect((await app.findByNameFuzzy("alice"))?.id).toBe(id);
    expect((await app.findByName("Alice")).map((person) => person.id)).toEqual([id]);
    expect(await app.findByBondLevel("guardian")).toEqual([]);
  });

  it("reads a channel an app names as the platform its accounts live on", async () => {
    app = appPersonMapping(people, (channel) =>
      channel === "telegram_user" || channel === "tg-second" ? "telegram" : channel,
    );
    const id = await app.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
      channelMappings: [{ channel: "telegram_user", channelUserId: "1001" }],
    });

    // The bot and a second bot hear the same Telegram account.
    expect((await app.findByChannelUser("telegram", "1001"))?.id).toBe(id);
    expect((await app.findByChannelUser("tg-second", "1001"))?.id).toBe(id);
    expect((await app.findByChannelUser("telegram", "1001"))?.channelMappings).toEqual([
      { channel: "telegram", channelUserId: "1001" },
    ]);
  });

  it("answers null for an account nobody holds", async () => {
    expect(await app.findByChannelUser("telegram", "tg-nobody")).toBeNull();
    expect(await app.findByAccount!({ platform: "telegram", id: "tg-nobody" })).toBeNull();
  });

  it("links and finds a person by the account an app names", async () => {
    // A channel name that would read as another platform, to show the account
    // is taken as it is.
    app = appPersonMapping(people, () => "elsewhere");
    const id = await app.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
      accounts: [{ platform: "lark", id: "ou_alice" }],
    });
    await app.addAccount!(id, { platform: "telegram", id: "1001" });

    expect((await app.findByAccount!({ platform: "lark", id: "ou_alice" }))?.id).toBe(id);
    expect((await app.findByAccount!({ platform: "telegram", id: "1001" }))?.accounts).toEqual(
      expect.arrayContaining([
        { platform: "lark", id: "ou_alice" },
        { platform: "telegram", id: "1001" },
      ]),
    );
  });
});
