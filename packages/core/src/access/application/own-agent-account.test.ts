import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { SettingsRepository } from "../../db/repositories/settings.js";
import { guardianAuth, links, persons } from "../../db/schema.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { accountEntry } from "./account-entry.js";
import {
  guardianSeatCreated,
  inviteMember,
  memberContext,
  type MemberContext,
  seatAccounts,
} from "./members.js";
import { OWN_AGENTS_GIVEN_KEY, ownAgentAccount } from "./own-agent-account.js";

const agent = (accountId: string) => ({ platform: "agents", accountId });

describe("ownAgentAccount", () => {
  let testDb: TestDb;
  let ctx: MemberContext;
  let settings: SettingsRepository;
  let give: (agentId: string) => void;
  let guardianId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    ctx = memberContext(testDb.db);
    settings = new SettingsRepository(testDb.db);
    give = ownAgentAccount(testDb.db, "agents");
    testDb.db
      .insert(guardianAuth)
      .values({
        id: "seat",
        userId: "u",
        passwordHash: "x",
        email: "owner@example.com",
        createdAt: new Date(),
      })
      .run();
    guardianId = (
      await guardianSeatCreated(ctx, { accounts: seatAccounts({ email: "owner@example.com" }) })
    ).id;
  });
  afterEach(() => testDb.close());

  it("gives the guardian the agent's account and records it, with People's tables empty", async () => {
    give("ep-atlas");

    expect((await ctx.identity.personOf(agent("ep-atlas")))?.id).toBe(guardianId);
    expect(await settings.get(OWN_AGENTS_GIVEN_KEY)).toEqual(["ep-atlas"]);
    expect(testDb.db.select().from(persons).all()).toEqual([]);
    expect(testDb.db.select().from(links).all()).toEqual([]);
  });

  it("lets the agent in as the guardian from its first message", async () => {
    const enter = accountEntry({ db: testDb.db });
    expect(await enter({ platform: "agents", id: "ep-atlas" })).toEqual({ kind: "unknown" });

    give("ep-atlas");

    expect(await enter({ platform: "agents", id: "ep-atlas" })).toMatchObject({
      kind: "entered",
      person: { kind: "guardian", userId: "u" },
    });
  });

  it("leaves an account that belongs to someone with them", async () => {
    const ada = await inviteMember(ctx, "ada@example.com");
    await ctx.identity.addAccount(ada.id, agent("ep-atlas"));

    give("ep-atlas");

    expect((await ctx.identity.personOf(agent("ep-atlas")))?.id).toBe(ada.id);
    expect(await settings.get(OWN_AGENTS_GIVEN_KEY)).toBeNull();
  });

  it("does not give again an agent whose account the guardian lost", async () => {
    give("ep-atlas");
    await ctx.identity.removeAccount(agent("ep-atlas"));

    give("ep-atlas");

    expect(await ctx.identity.personOf(agent("ep-atlas"))).toBeNull();
  });

  it("keeps an agent recorded before, such as one given in People and since removed", async () => {
    await settings.set(OWN_AGENTS_GIVEN_KEY, ["ep-atlas"]);

    give("ep-atlas");
    give("ep-atlas-2");

    expect(await ctx.identity.personOf(agent("ep-atlas"))).toBeNull();
    expect((await ctx.identity.personOf(agent("ep-atlas-2")))?.id).toBe(guardianId);
    expect(await settings.get(OWN_AGENTS_GIVEN_KEY)).toEqual(["ep-atlas", "ep-atlas-2"]);
  });

  it("records every agent when several first messages arrive at once", async () => {
    await Promise.all(["ep-atlas", "ep-muse", "ep-nova"].map(async (id) => give(id)));

    expect([...((await settings.get<string[]>(OWN_AGENTS_GIVEN_KEY)) ?? [])].sort()).toEqual([
      "ep-atlas",
      "ep-muse",
      "ep-nova",
    ]);
  });
});

describe("ownAgentAccount with no guardian", () => {
  it("gives nobody the account and records nothing", async () => {
    const testDb = createTestDb();
    const ctx = memberContext(testDb.db);

    ownAgentAccount(testDb.db, "agents")("ep-atlas");

    expect(await ctx.identity.personOf(agent("ep-atlas"))).toBeNull();
    expect(await new SettingsRepository(testDb.db).get(OWN_AGENTS_GIVEN_KEY)).toBeNull();
    testDb.close();
  });
});
