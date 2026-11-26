// The wiring between People's delegate links and Access's rule that an account
// acts for the guardian, as index.ts builds it.

import type { ChannelMessage } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { actsForGuardian, startedActingForGuardian } from "./access/acts-for-guardian.js";
import { accountEntry } from "./access/application/account-entry.js";
import { peopleLinkChanged } from "./access/application/guardian-links.js";
import { guardianSeatCreated, memberContext } from "./access/application/members.js";
import { channelMessageOf } from "./chats/connected-accounts/channel-message.js";
import { toAgentInboundMessage } from "./connections/integrations/agents.js";
import { SettingsRepository } from "./db/repositories/settings.js";
import { guardianAuth, persons } from "./db/schema.js";
import { createAgentsGuardianLink } from "./people/agents-guardian.js";
import { DrizzlePeopleRepository } from "./people/infrastructure/drizzle-people-repository.js";
import { createTestDb, type TestDb } from "./test/db.js";

const ATLAS = { platform: "agents", id: "ep-atlas" };

function firstMessage(): ChannelMessage {
  const inbound = toAgentInboundMessage({
    messageId: "msg_1",
    from: { agentId: ATLAS.id, name: "atlas", kind: "dot", account: "ouou", sameAccount: true },
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

describe("a same-account agent acting for the guardian", () => {
  let testDb: TestDb;
  let people: DrizzlePeopleRepository;
  beforeEach(async () => {
    testDb = createTestDb();
    people = new DrizzlePeopleRepository(testDb.db, (change) =>
      peopleLinkChanged(testDb.db, change),
    );
    testDb.db
      .insert(persons)
      .values({ id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: new Date() })
      .run();
    await testDb.db
      .insert(guardianAuth)
      .values({ id: "seat", userId: "owner", passwordHash: "", createdAt: new Date() });
    await guardianSeatCreated(memberContext(testDb.db), { accounts: [] });
    await createAgentsGuardianLink({
      peopleRepo: people,
      settingsRepo: new SettingsRepository(testDb.db),
      platform: "agents",
      startedActingForGuardian: (account) => startedActingForGuardian(testDb.db, account),
    })(firstMessage());
  });
  afterEach(() => testDb.close());

  it("is let in as the guardian from its first message", async () => {
    expect(await accountEntry({ db: testDb.db })(ATLAS)).toEqual({
      kind: "entered",
      person: { kind: "guardian", userId: "owner", via: "loopback" },
    });
  });

  it("stops acting for the guardian when the guardian removes its link in People", async () => {
    await people.unlink(ATLAS, "owner");

    expect(actsForGuardian(testDb.db, ATLAS)).toBe(false);
    expect(await accountEntry({ db: testDb.db })(ATLAS)).toEqual({ kind: "unknown" });
  });

  it("stops acting for the guardian when its link moves to another person in People", async () => {
    const alice = await people.create({ displayName: "Alice", bondLevel: "other" });
    await people.move(ATLAS, "owner", alice);

    expect(actsForGuardian(testDb.db, ATLAS)).toBe(false);
  });

  it("keeps acting for the guardian through a change to the guardian's other accounts", async () => {
    const wechat = { platform: "wechat", id: "w-owner" };
    people.linkStated(wechat, "owner");
    people.readdress("owner", wechat, "w-owner-2");
    await people.unlink({ platform: "wechat", id: "w-owner-2" }, "owner");
    people.linkStated(ATLAS, "owner");

    expect(actsForGuardian(testDb.db, ATLAS)).toBe(true);
  });
});
