import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { ActionEngine, type ActionRunContext } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { PeopleRepository } from "../db/repositories/people.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/db.js";
import { READ_PERSON_ACTION, registerReadPersonAction } from "./read-person.js";

type Actor = NonNullable<ActionRunContext["actor"]>;

const guardian: Actor = { kind: "guardian", userId: "guardian", via: "cookie" };
const visitor: Actor = { kind: "visitor", accountId: "visitor", email: "visitor@example.test" };

let testDb: TestDb;
let people: PeopleRepository;
let registry: ActionRegistryImpl;
let engine: ActionEngine;

beforeEach(async () => {
  testDb = createTestDb();
  people = new PeopleRepository(testDb.db);
  registry = new ActionRegistryImpl();
  registerReadPersonAction(registry, {
    people,
    readNotes: async (path) => (path === "memory/relationship/ana.md" ? "Runs the venue." : null),
  });
  engine = new ActionEngine(registry, createActionEngineRepos(testDb.db), {
    processRole: "main",
    workerWarmPoolSize: 0,
    isFirstPartyAction: (name) => name === READ_PERSON_ACTION,
    actionWorkerFork: rs.fn(() => {
      throw new Error("Reading a person must run in main");
    }),
  });
});

afterEach(() => testDb.close());

const read = (name: unknown, context: ActionRunContext = {}) =>
  engine.run(READ_PERSON_ACTION, { name }, context);

describe("core:read_person", () => {
  it("reads every person by that name, ignoring case, with their accounts and notes", async () => {
    await people.create({
      displayName: "Ana Lopez",
      bondLevel: "inner-circle",
      profilePath: "memory/relationship/ana.md",
      links: [{ platform: "discord", id: "ana" }],
    });
    await people.create({ displayName: "Bob", bondLevel: "acquaintance" });

    expect(await read("ana lopez")).toEqual({
      status: "ok",
      data: {
        people: [
          {
            name: "Ana Lopez",
            bondLevel: "inner-circle",
            accounts: [{ platform: "discord", id: "ana" }],
            notes: "Runs the venue.",
          },
        ],
      },
    });
    expect(await read("Bob")).toMatchObject({
      status: "ok",
      data: { people: [{ name: "Bob", notes: null }] },
    });
  });

  it("answers no one for a name nobody has", async () => {
    expect(await read("Nobody", { actor: guardian })).toEqual({
      status: "ok",
      data: { people: [] },
    });
  });

  it("refuses a visitor's chat", async () => {
    await people.create({ displayName: "Ana Lopez", bondLevel: "inner-circle" });
    expect((await read("Ana Lopez", { actor: visitor })).status).toBe("error");
  });

  it("is available through the main agent wildcard", () => {
    expect(registry.getForAgent(["*"]).map((action) => action.config.name)).toContain(
      READ_PERSON_ACTION,
    );
  });
});
