// The guardian an app reads through `findByBondLevel("guardian")`, as index.ts
// wires it: who the guardian is from Access, their accounts from Identity.

import type { ChannelMessage, PersonMappingRepository } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import { peopleLinkChanged } from "./access/application/guardian-links.js";
import {
  guardianSeatCreated,
  guardianWithAccounts,
  memberContext,
  seatAccounts,
} from "./access/application/members.js";
import { channelMessageOf } from "./chats/connected-accounts/channel-message.js";
import { toAgentInboundMessage } from "./connections/integrations/agents.js";
import { SettingsRepository } from "./db/repositories/settings.js";
import { links, persons } from "./db/schema.js";
import {
  accountCodeContext,
  accountCodeIssued,
  accountCodeRedeemed,
} from "./identity/application/account-codes.js";
import { createIdentity } from "./identity/identity.js";
import { createAgentsGuardianLink } from "./people/agents-guardian.js";
import { appPersonMapping } from "./people/app-person-mapping.js";
import { DrizzlePeopleRepository } from "./people/infrastructure/drizzle-people-repository.js";
import { createTestDb, type TestDb } from "./test/db.js";

const SIGN_IN = { platform: "rome-cloud-email", id: "owner@example.com" };

describe("the guardian as apps read it", () => {
  let testDb: TestDb;
  let people: DrizzlePeopleRepository;
  let app: PersonMappingRepository;
  let guardianId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    const { db } = testDb;
    people = new DrizzlePeopleRepository(db, (change) => peopleLinkChanged(db, change));
    db.insert(persons)
      .values({ id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: new Date() })
      .run();
    guardianId = (
      await guardianSeatCreated(memberContext(db), {
        accounts: seatAccounts({ email: SIGN_IN.id }),
        name: "Owner",
      })
    ).id;
    app = appPersonMapping(people, () => guardianWithAccounts(memberContext(db)));
  });
  afterEach(() => testDb.close());

  async function guardianAccounts() {
    const [guardian, ...others] = await app.findByBondLevel("guardian");
    expect(others).toEqual([]);
    return guardian?.accounts;
  }

  it("answers what People answered for accounts on two platforms, beside the seat's sign-in", async () => {
    people.linkStated({ platform: "slack", id: "T1/U1" }, "owner");
    people.linkStated({ platform: "telegram", id: "42" }, "owner");
    const [before] = await people.byBondLevel("guardian");

    const [guardian] = await app.findByBondLevel("guardian");

    expect(guardian).toMatchObject({ id: guardianId, displayName: before.displayName });
    expect(guardian.bondLevel).toBe("guardian");
    const today = before.links.map(({ platform, id }) => ({ platform, id }));
    expect(guardian.accounts).toEqual(expect.arrayContaining([...today, SIGN_IN]));
    expect(guardian.accounts).toHaveLength(today.length + 1);
    expect(guardian.channelMappings).toEqual(
      guardian.accounts?.map(({ platform, id }) => ({ channel: platform, channelUserId: id })),
    );
  });

  it("still answers the guardian's accounts once People's links to them are gone", async () => {
    people.linkStated({ platform: "slack", id: "T1/U1" }, "owner");
    people.linkStated({ platform: "telegram", id: "42" }, "owner");
    testDb.db.delete(links).where(eq(links.personId, "owner")).run();

    expect(await guardianAccounts()).toEqual(
      expect.arrayContaining([
        { platform: "slack", id: "T1/U1" },
        { platform: "telegram", id: "42" },
      ]),
    );
  });

  it("answers an account added with a code and an agent's account", async () => {
    const codes = accountCodeContext(testDb.db);
    const { code } = await accountCodeIssued(codes, guardianId);
    await accountCodeRedeemed(codes, code, { platform: "discord", accountId: "d-7" });
    const link = createAgentsGuardianLink({
      peopleRepo: people,
      settingsRepo: new SettingsRepository(testDb.db),
      platform: "agents",
    });
    await link(agentMessage("ep-atlas"));

    expect(await guardianAccounts()).toEqual(
      expect.arrayContaining([
        { platform: "discord", id: "d-7" },
        { platform: "agents", id: "ep-atlas" },
      ]),
    );
  });

  it("puts the account given last first, so a stale id on the same platform does not win", async () => {
    const identity = createIdentity(testDb.db);
    await identity.addAccount(guardianId, { platform: "wechat", accountId: "wx-1-old" });
    await identity.addAccount(guardianId, { platform: "wechat", accountId: "wx-2-new" });

    const accounts = await guardianAccounts();

    expect(accounts?.find((account) => account.platform === "wechat")).toEqual({
      platform: "wechat",
      id: "wx-2-new",
    });
  });

  it("answers no guardian while Rome has none", async () => {
    app = appPersonMapping(people, async () => null);
    expect(await app.findByBondLevel("guardian")).toEqual([]);
  });

  it("answers another bond level from People, as before", async () => {
    const id = await people.create({
      displayName: "Alice",
      bondLevel: "inner-circle",
      links: [{ platform: "telegram", id: "tg-alice" }],
    });

    const [alice, ...others] = await app.findByBondLevel("inner-circle");

    expect(others).toEqual([]);
    expect(alice).toMatchObject({
      id,
      displayName: "Alice",
      bondLevel: "inner-circle",
      accounts: [{ platform: "telegram", id: "tg-alice" }],
    });
  });
});

/** A message from an agent in this Rome's own Rome Cloud account. */
function agentMessage(agentId: string): ChannelMessage {
  const inbound = toAgentInboundMessage({
    messageId: "msg_1",
    from: { agentId, name: "atlas", kind: "dot", account: "ouou", sameAccount: true },
    to: { agentId: "ep-home", name: "home-rome" },
    sentAt: "2026-10-07T09:28:38.000Z",
    text: "Hello.",
    data: null,
    inReplyTo: null,
    hop: 1,
  });
  if (!inbound) throw new Error("the envelope names no sender agent");
  return channelMessageOf(inbound, "agents");
}
