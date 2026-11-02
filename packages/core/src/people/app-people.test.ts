import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { PeopleRepository } from "../db/repositories/people.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { appPeople } from "./app-people.js";

describe("appPeople", () => {
  let testDb: TestDb;
  let people: PeopleRepository;

  beforeEach(() => {
    testDb = createTestDb();
    people = new PeopleRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("answers the guardian's own accounts", async () => {
    await people.create({
      displayName: "Ouou",
      bondLevel: "guardian",
      links: [
        { platform: "telegram", id: "8123456789" },
        { platform: "slack", id: "U01" },
      ],
    });
    await people.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
      links: [{ platform: "telegram", id: "tg-alice" }],
    });

    const { accounts } = await appPeople(people).guardian();

    expect(accounts).toEqual(
      expect.arrayContaining([
        { platform: "telegram", id: "8123456789" },
        { platform: "slack", id: "U01" },
      ]),
    );
    expect(accounts).toHaveLength(2);
  });

  it("leaves out an agent's account delegated by the guardian", async () => {
    const guardian = await people.create({
      displayName: "Ouou",
      bondLevel: "guardian",
      links: [{ platform: "telegram", id: "8123456789" }],
    });
    people.linkDelegate({ platform: "discord", id: "agent-1" }, guardian);

    const { accounts } = await appPeople(people).guardian();

    expect(accounts).toEqual([{ platform: "telegram", id: "8123456789" }]);
  });

  it("answers no accounts while nobody is the guardian", async () => {
    expect(await appPeople(people).guardian()).toEqual({ accounts: [] });
  });
});
