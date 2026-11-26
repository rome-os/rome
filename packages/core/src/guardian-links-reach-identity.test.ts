// The wiring between People's links to the guardian and the guardian's
// accounts in Identity, as index.ts builds it.

import type { ChannelMessage } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { accountEntry } from "./access/application/account-entry.js";
import { backfillMembers } from "./access/application/backfill-members.js";
import { peopleLinkChanged } from "./access/application/guardian-links.js";
import { guardianSeatCreated, memberContext, seatAccounts } from "./access/application/members.js";
import { channelMessageOf } from "./chats/connected-accounts/channel-message.js";
import { toAgentInboundMessage } from "./connections/integrations/agents.js";
import { SettingsRepository } from "./db/repositories/settings.js";
import { guardianAuth, persons, settings } from "./db/schema.js";
import {
  accountCodeContext,
  accountCodeIssued,
  accountCodeRedeemed,
} from "./identity/application/account-codes.js";
import { createIdentity } from "./identity/identity.js";
import { createAgentsGuardianLink } from "./people/agents-guardian.js";
import { linkGuardianOnConnect, linkGuardianToAccount } from "./people/guardian-mapping.js";
import { DrizzlePeopleRepository } from "./people/infrastructure/drizzle-people-repository.js";
import { createTestDb, type TestDb } from "./test/db.js";

/** A message from an agent in this Rome's own Rome Cloud account. */
function agentMessage(agentId: string): ChannelMessage {
  const inbound = toAgentInboundMessage({
    messageId: "msg_1",
    from: { agentId, name: "atlas", kind: "dot", account: "ouou", sameAccount: true },
    to: { agentId: "ep-home", name: "home-rome" },
    sentAt: "2026-10-07T09:28:38.000Z",
    text: "17 + 25 = 42.",
    data: null,
    inReplyTo: null,
    hop: 1,
  });
  if (!inbound) throw new Error("the envelope names no sender agent");
  return channelMessageOf(inbound, "agents");
}

const SEAT_EMAIL = "owner@example.com";

describe("the guardian's links in People reaching Identity", () => {
  let testDb: TestDb;
  let people: DrizzlePeopleRepository;
  let guardianId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    const { db } = testDb;
    people = new DrizzlePeopleRepository(db, (change) => peopleLinkChanged(db, change));
    const now = new Date();
    db.insert(persons)
      .values({ id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: now })
      .run();
    db.insert(guardianAuth)
      .values({ id: "seat", userId: "u", passwordHash: "x", email: SEAT_EMAIL, createdAt: now })
      .run();
    guardianId = (
      await guardianSeatCreated(memberContext(db), {
        accounts: seatAccounts({ email: SEAT_EMAIL }),
      })
    ).id;
  });
  afterEach(() => testDb.close());

  /** The guardian's accounts in Identity, other than the seat's sign-in. */
  async function inIdentity(): Promise<string[]> {
    const accounts = await createIdentity(testDb.db).accountsOf(guardianId);
    return accounts
      .filter((a) => a.platform !== "rome-cloud-email")
      .map((a) => `${a.platform}:${a.accountId}`);
  }

  async function connect(platform: string, id: string, stableId = false): Promise<void> {
    const apply = await linkGuardianOnConnect(people).prepare({
      platform,
      connectedBy: { id, stableId },
    });
    testDb.db.transaction((tx) => apply?.(tx, { reachesAnotherAccount: false }));
  }

  it("follows a connect, a re-point, a WhatsApp self link and an unlink, and leaves a code's account", async () => {
    const { code } = await accountCodeIssued(accountCodeContext(testDb.db), guardianId);
    await accountCodeRedeemed(accountCodeContext(testDb.db), code, {
      platform: "telegram",
      accountId: "99",
    });

    await connect("wechat", "wx-old");
    expect(await inIdentity()).toEqual(["telegram:99", "wechat:wx-old"]);

    // A kind whose ids are not stable re-points the guardian's one link there.
    await connect("wechat", "wx-new");
    expect(await inIdentity()).toEqual(["telegram:99", "wechat:wx-new"]);

    await linkGuardianToAccount(people, "whatsapp", "15550001@s.whatsapp.net");
    expect(await inIdentity()).toEqual([
      "telegram:99",
      "wechat:wx-new",
      "whatsapp:15550001@s.whatsapp.net",
    ]);

    await people.unlink({ platform: "wechat", id: "wx-new" });
    expect(await inIdentity()).toEqual(["telegram:99", "whatsapp:15550001@s.whatsapp.net"]);

    await backfillMembers(testDb.db);
    expect(await inIdentity()).toEqual(["telegram:99", "whatsapp:15550001@s.whatsapp.net"]);
  });

  it("makes a same-account agent's account the guardian's from its first message, and lets it in as the guardian", async () => {
    const link = createAgentsGuardianLink({
      peopleRepo: people,
      settingsRepo: new SettingsRepository(testDb.db),
      platform: "agents",
    });
    const enter = accountEntry({ db: testDb.db });
    const agent = { platform: "agents", id: "ep-atlas" };
    expect(await enter(agent)).toEqual({ kind: "unknown" });

    await link(agentMessage("ep-atlas"));
    expect(await inIdentity()).toEqual(["agents:ep-atlas"]);
    expect(await enter(agent)).toEqual({
      kind: "entered",
      person: { kind: "guardian", userId: "u", via: "account" },
    });

    await people.unlink(agent);
    expect(await inIdentity()).toEqual([]);
    expect(await enter(agent)).toEqual({ kind: "unknown" });
  });

  it("gives nobody a delegate link to another person or a Rome Cloud id", async () => {
    testDb.db
      .insert(persons)
      .values({ id: "fred", displayName: "Fred", bondLevel: "inner-circle", createdAt: new Date() })
      .run();
    people.linkDelegate({ platform: "agents", id: "ep-fred" }, "fred");
    people.linkStated({ platform: "rome-cloud", id: "acct-owner" }, "owner");
    expect(await inIdentity()).toEqual([]);
    const identity = createIdentity(testDb.db);
    expect(await identity.personOf({ platform: "agents", accountId: "ep-fred" })).toBeNull();
  });

  it("rolls the connect back, credential and link, when Identity cannot be written", async () => {
    const failing = new DrizzlePeopleRepository(testDb.db, () => {
      throw new Error("identity write failed");
    });
    const apply = await linkGuardianOnConnect(failing).prepare({
      platform: "wechat",
      connectedBy: { id: "wx-1" },
    });
    expect(() =>
      testDb.db.transaction((tx) => {
        // Stands in for the credential the grant writes in this transaction.
        tx.insert(settings).values({ key: "credential", value: 1, updatedAt: new Date() }).run();
        apply?.(tx, { reachesAnotherAccount: false });
      }),
    ).toThrow("identity write failed");
    expect(testDb.db.select().from(settings).all()).toEqual([]);
    expect(await people.byAccount({ platform: "wechat", id: "wx-1" })).toBeNull();
  });
});
