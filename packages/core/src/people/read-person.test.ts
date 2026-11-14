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
let notes: Map<string, string>;

beforeEach(async () => {
  testDb = createTestDb();
  notes = new Map([["memory/relationship/ana.md", "Runs the venue."]]);
  people = new PeopleRepository(testDb.db);
  registry = new ActionRegistryImpl();
  registerReadPersonAction(registry, {
    people,
    ownerOfChat: async (chatId) =>
      chatId === "visitor-chat"
        ? "visitor:visitor"
        : chatId === "guardian-chat"
          ? "guardian"
          : null,
    readNotes: async (path) => notes.get(path) ?? null,
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
    const bob = await people.create({ displayName: "Bob", bondLevel: "acquaintance" });
    // A person created with no profile path keeps their notes in the file
    // named after their id.
    notes.set(`memory/relationship/${bob}.md`, "Plays bass.");

    expect(await read("ana lopez", { actor: guardian })).toEqual({
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
    expect(await read("Bob", { actor: guardian })).toMatchObject({
      status: "ok",
      data: { people: [{ name: "Bob", notes: "Plays bass." }] },
    });
  });

  it("answers no one for a name nobody has", async () => {
    expect(await read("Nobody", { actor: guardian })).toEqual({
      status: "ok",
      data: { people: [] },
    });
  });

  it("refuses a visitor, and a turn no one started in a chat a visitor owns", async () => {
    await people.create({ displayName: "Ana Lopez", bondLevel: "inner-circle" });
    expect((await read("Ana Lopez", { actor: visitor })).status).toBe("error");
    const visitorChat = { channel: "webchat", threadId: "visitor-chat" };
    expect((await read("Ana Lopez", { channelContext: visitorChat })).status).toBe("error");
    const goneChat = { channel: "webchat", threadId: "gone-chat" };
    expect((await read("Ana Lopez", { channelContext: goneChat })).status).toBe("error");
  });

  it("refuses a turn with neither an actor nor a chat, such as an agent summoned from a visitor's task", async () => {
    await people.create({ displayName: "Ana Lopez", bondLevel: "inner-circle" });
    expect((await read("Ana Lopez", {})).status).toBe("error");
  });

  it("reads for a turn no one started in the guardian's chat or a chat on a connection", async () => {
    await people.create({ displayName: "Ana Lopez", bondLevel: "inner-circle" });
    const guardianChat = { channel: "webchat", threadId: "guardian-chat" };
    expect((await read("Ana Lopez", { channelContext: guardianChat })).status).toBe("ok");
    const group = { channel: "discord", threadId: "group-1" };
    expect((await read("Ana Lopez", { channelContext: group })).status).toBe("ok");
  });

  it("is available through the main agent wildcard", () => {
    expect(registry.getForAgent(["*"]).map((action) => action.config.name)).toContain(
      READ_PERSON_ACTION,
    );
  });
});
