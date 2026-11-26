import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import type { PersonMappingRepository } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../test/db.js";
import { DrizzlePeopleRepository } from "./infrastructure/drizzle-people-repository.js";
import type { PeopleRepository } from "./model/people-repository.js";
import { appPersonMapping } from "./app-person-mapping.js";

/** The guardian's answer comes from Access and Identity, tested in
 *  src/guardian-for-apps.test.ts. */
const noGuardian = async () => null;

describe("appPersonMapping", () => {
  let testDb: TestDb;
  let people: PeopleRepository;
  let app: PersonMappingRepository;

  beforeEach(() => {
    testDb = createTestDb();
    people = new DrizzlePeopleRepository(testDb.db);
    app = appPersonMapping(people, noGuardian);
  });

  afterEach(() => {
    testDb.close();
  });

  it("answers apps with the SDK's channelMappings field, and accounts beside it", async () => {
    const id = await people.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
      links: [
        { platform: "telegram", id: "tg-alice" },
        { platform: "whatsapp", id: "wa-alice" },
      ],
    });

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
    app = appPersonMapping(people, noGuardian, (channel) =>
      channel === "telegram_user" || channel === "tg-second" ? "telegram" : channel,
    );
    const id = await people.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
      links: [{ platform: "telegram", id: "1001" }],
    });

    // The bot and a second bot hear the same Telegram account.
    expect((await app.findByChannelUser("telegram_user", "1001"))?.id).toBe(id);
    expect((await app.findByChannelUser("tg-second", "1001"))?.id).toBe(id);
    expect((await app.findByChannelUser("telegram", "1001"))?.channelMappings).toEqual([
      { channel: "telegram", channelUserId: "1001" },
    ]);
  });

  it("answers null for an account nobody holds", async () => {
    expect(await app.findByChannelUser("telegram", "tg-nobody")).toBeNull();
    expect(await app.findByAccount!({ platform: "telegram", id: "tg-nobody" })).toBeNull();
  });

  it("finds a person by the account an app names, as it is", async () => {
    // A channel name that would read as another platform, to show the account
    // is taken as it is.
    app = appPersonMapping(people, noGuardian, () => "elsewhere");
    const id = await people.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
      links: [{ platform: "lark", id: "ou_alice" }],
    });

    expect((await app.findByAccount!({ platform: "lark", id: "ou_alice" }))?.id).toBe(id);
  });

  it("refuses every link an app asks for, so only the guardian links an account", async () => {
    const id = await people.create({ displayName: "Bob", bondLevel: "acquaintance", links: [] });
    const other = await people.create({
      displayName: "Carol",
      bondLevel: "acquaintance",
      links: [{ platform: "telegram", id: "tg-carol" }],
    });

    await expect(app.addChannelMapping(id, "telegram", "tg-carol")).rejects.toThrow(
      /only the guardian/i,
    );
    await expect(app.addAccount!(id, { platform: "telegram", id: "tg-carol" })).rejects.toThrow(
      /only the guardian/i,
    );

    expect((await app.findByChannelUser("telegram", "tg-carol"))?.id).toBe(other);
  });

  it("refuses an app's request to add a person, and writes nothing", async () => {
    await expect(app.create({ displayName: "Dana", bondLevel: "acquaintance" })).rejects.toThrow(
      "Apps cannot add persons. Rome no longer lets an app add a person.",
    );
    expect(await people.all()).toEqual([]);
  });
});
