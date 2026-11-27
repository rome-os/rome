import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { links, persons } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { botsOfPersons, type HeardFrom } from "./bots-of-persons.js";
import { createIdentity } from "./identity.js";

function fromBot(senderId: string): HeardFrom {
  return { senderId, fromBot: true };
}

describe("botsOfPersons", () => {
  let testDb: TestDb;
  let read: (platform: string, message: HeardFrom) => Promise<void>;

  beforeEach(async () => {
    testDb = createTestDb();
    const identity = createIdentity(testDb.db);
    await identity.createPerson({
      name: "Ada",
      accounts: [{ platform: "discord", accountId: "ada-webhook" }],
    });
    read = botsOfPersons(identity);
  });
  afterEach(() => testDb.close());

  it("reads a bot account that belongs to a person as that person, with People's tables empty", async () => {
    const message = fromBot("ada-webhook");
    await read("discord", message);
    expect(message).not.toHaveProperty("fromBot");
    expect(testDb.db.select().from(persons).all()).toEqual([]);
    expect(testDb.db.select().from(links).all()).toEqual([]);
  });

  it("leaves a bot account that belongs to nobody a bot", async () => {
    const message = fromBot("ci-webhook");
    await read("discord", message);
    expect(message.fromBot).toBe(true);
  });

  it("reads the account on its own platform only", async () => {
    const message = fromBot("ada-webhook");
    await read("slack", message);
    expect(message.fromBot).toBe(true);
  });
});
