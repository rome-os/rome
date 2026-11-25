import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { ActionEngine, type ActionRunContext } from "../../../apps/actions/engine.js";
import { ActionRegistryImpl } from "../../../apps/actions/registry.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../../../test/db.js";
import { buildTestDeps } from "../../../test/helpers.js";
import type { PeopleRepository } from "../../model/people-repository.js";
import { LIST_PEOPLE_ACTION, listPeopleAction } from "./list-people.js";

type Actor = NonNullable<ActionRunContext["actor"]>;

const guardian: Actor = { kind: "guardian", userId: "guardian", via: "cookie" };
const visitor: Actor = { kind: "visitor", accountId: "visitor", email: "visitor@example.test" };

let testDb: TestDb;
let people: PeopleRepository;
let engine: ActionEngine;

beforeEach(async () => {
  testDb = createTestDb();
  const deps = await buildTestDeps(testDb.db);
  people = deps.peopleRepo;
  const registry = new ActionRegistryImpl();
  registry.register(
    listPeopleAction({
      ...deps,
      ownerOfChat: async (chatId) => (chatId === "visitor-chat" ? "visitor:visitor" : "guardian"),
    }),
  );
  engine = new ActionEngine(registry, createActionEngineRepos(testDb.db), {
    processRole: "main",
    workerWarmPoolSize: 0,
    isFirstPartyAction: (name) => name === LIST_PEOPLE_ACTION,
    actionWorkerFork: rs.fn(() => {
      throw new Error("Listing people must run in main");
    }),
  });
});

afterEach(() => testDb.close());

const list = (args: Record<string, unknown>, context: ActionRunContext = { actor: guardian }) =>
  engine.run(LIST_PEOPLE_ACTION, args, context);

describe("core:list_people", () => {
  it("lists the phone book, filtered by query and level", async () => {
    await people.create({
      displayName: "Ana Lopez",
      bondLevel: "inner-circle",
      links: [{ platform: "discord", id: "ana" }],
    });
    await people.create({ displayName: "Bob", bondLevel: "acquaintance" });

    const all = await list({});
    expect(all).toMatchObject({ status: "ok" });
    expect(all.status === "ok" && all.data).toMatchObject({
      people: [{ displayName: "Ana Lopez" }, { displayName: "Bob" }],
    });

    expect(await list({ query: "ana" })).toMatchObject({
      status: "ok",
      data: { people: [{ displayName: "Ana Lopez" }] },
    });
    const close = await list({ level: "inner-circle" });
    expect(close.status === "ok" && close.data).toMatchObject({
      people: [{ displayName: "Ana Lopez" }],
    });
  });

  it("refuses a level that names no bond level", async () => {
    expect(await list({ level: "best-friends" })).toMatchObject({ status: "error" });
  });

  it("refuses anyone but the guardian's agents", async () => {
    expect(await list({}, { actor: visitor })).toMatchObject({ status: "error" });
    expect(
      await list({}, { channelContext: { channel: "webchat", threadId: "visitor-chat" } }),
    ).toMatchObject({ status: "error" });
    expect(await list({}, {})).toMatchObject({ status: "error" });
  });
});
