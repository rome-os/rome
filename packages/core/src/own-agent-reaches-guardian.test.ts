// The wiring between Rome Cloud's word that an agent is the guardian's and the
// guardian's accounts in Identity, as index.ts builds it.

import type { ChannelMessage } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { accountEntry } from "./access/application/account-entry.js";
import { guardianSeatCreated, memberContext, seatAccounts } from "./access/application/members.js";
import { channelMessageOf } from "./chats/connected-accounts/channel-message.js";
import { ownAgentAccount } from "./access/application/own-agent-account.js";
import { ownAccountAgentOf, toAgentInboundMessage } from "./connections/integrations/agents.js";
import { guardianAuth } from "./db/schema.js";
import { createIdentity } from "./identity/identity.js";
import { createTestDb, type TestDb } from "./test/db.js";

/** A message from an agent, by default one in this Rome's own Rome Cloud account. */
function agentMessage(agentId: string, sameAccount = true): ChannelMessage {
  const inbound = toAgentInboundMessage({
    messageId: "msg_1",
    from: { agentId, name: "atlas", kind: "dot", account: "ouou", sameAccount },
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

describe("an agent in the guardian's own Rome Cloud account", () => {
  let testDb: TestDb;
  let guardianId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    const { db } = testDb;
    db.insert(guardianAuth)
      .values({
        id: "seat",
        userId: "u",
        passwordHash: "x",
        email: SEAT_EMAIL,
        createdAt: new Date(),
      })
      .run();
    guardianId = (
      await guardianSeatCreated(memberContext(db), {
        accounts: seatAccounts({ email: SEAT_EMAIL }),
      })
    ).id;
  });
  afterEach(() => testDb.close());

  /** The guardian's accounts in Identity, other than the seat's sign-in and
   *  the mail account it gives. */
  async function inIdentity(): Promise<string[]> {
    const accounts = await createIdentity(testDb.db).accountsOf(guardianId);
    return accounts
      .filter((a) => a.accountId !== SEAT_EMAIL)
      .map((a) => `${a.platform}:${a.accountId}`);
  }

  it("makes an agent's account the guardian's from its first message when Rome Cloud says it is theirs, and lets it in as the guardian", async () => {
    const give = ownAgentAccount(testDb.db, "agents");
    const admit = (message: ChannelMessage) => {
      const agentId = ownAccountAgentOf(message);
      if (agentId) give(agentId);
    };
    const enter = accountEntry({ db: testDb.db });
    const agent = { platform: "agents", id: "ep-atlas" };
    expect(await enter(agent)).toEqual({ kind: "unknown" });

    admit(agentMessage("ep-friend", false));
    admit(agentMessage("ep-atlas"));
    expect(await inIdentity()).toEqual(["agents:ep-atlas"]);
    expect(await enter(agent)).toEqual({
      kind: "entered",
      person: { kind: "guardian", userId: "u", via: "account" },
    });
  });
});
