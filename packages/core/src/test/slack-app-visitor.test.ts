// Who the Slack app connection answers as the guardian: only the member whose
// account is the guardian's. Built in test/ because it crosses the connection
// and Access. The guardian's account (`T_A/U_GUARDIAN`) is theirs in Identity,
// and direct messages from that member and from another are heard through the
// connection and let in as the message path lets them in.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChannelMessage } from "@rome-os/app-runtime";
import { platformOf } from "@rome/api-types/platform";
import { SLACK_APP_KIND } from "../connections/integrations/slack-app.js";
import {
  depositSignature,
  SLACK_DEPOSIT_HEADER,
  SLACK_SIGNATURE_HEADER,
} from "../connections/kinds/slack-app/deposit.js";
import { type MailboxFrame, SlackAppAdapter } from "../connections/kinds/slack-app/slack-app.js";
import { accountEntry } from "../access/application/account-entry.js";
import { guardianSeatCreated, memberContext, seatAccounts } from "../access/application/members.js";
import { guardianAuth } from "../db/schema.js";
import { createIdentity } from "../identity/identity.js";
import { createTestDb, type TestDb } from "./db.js";
import { channelMessageOf } from "../chats/connected-accounts/channel-message.js";

const TEAM = "T_A";
const BOT = "U_BOT";
const DEPOSIT_KEY = "deposit-key-a";
const INSTALLER = "U_GUARDIAN";

function dm(i: number, channel: string, user: string): MailboxFrame {
  const body = new TextEncoder().encode(
    JSON.stringify({
      type: "event_callback",
      team_id: TEAM,
      api_app_id: "A_ROME",
      event_id: `Ev${i}`,
      event: {
        type: "message",
        channel_type: "im",
        channel,
        user,
        text: `message ${i}`,
        ts: `1700000000.${String(i).padStart(6, "0")}`,
      },
    }),
  );
  return {
    headers: {
      [SLACK_DEPOSIT_HEADER]: "1",
      [SLACK_SIGNATURE_HEADER]: depositSignature(body, DEPOSIT_KEY),
    },
    body,
  };
}

describe("Slack app members who did not sign in (R12)", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => testDb.close());

  it("answers the member who signed in as the guardian, and another member as a visitor", async () => {
    const email = "owner@example.com";
    testDb.db
      .insert(guardianAuth)
      .values({ id: "seat", userId: "u", passwordHash: "x", email, createdAt: new Date() })
      .run();
    const guardian = await guardianSeatCreated(memberContext(testDb.db), {
      accounts: seatAccounts({ email }),
    });
    // The guardian's Slack account, theirs in Identity.
    await createIdentity(testDb.db).addAccount(guardian.id, {
      platform: platformOf(SLACK_APP_KIND),
      accountId: `${TEAM}/${INSTALLER}`,
    });

    let onFrame: ((frame: MailboxFrame) => Promise<{ status: number }>) | null = null;
    const adapter = new SlackAppAdapter({
      channel: SLACK_APP_KIND,
      teamId: TEAM,
      botUserId: BOT,
      depositKey: DEPOSIT_KEY,
      bound: async () => true,
      deliveryAttempts: 4,
      api: {
        postMessage: async () => ({ ts: "9.0" }),
        openDirectMessage: async () => "D_NEW",
        addReaction: async () => {},
        removeReaction: async () => {},
        postEphemeral: async () => {},
        userName: async () => ({}),
        conversationHistory: async () => ({ messages: [], hasMore: false }),
        conversationReplies: async () => ({ messages: [] }),
        memberChannels: async () => ({ channels: [] }),
      },
    });
    onFrame = (frame) => adapter.handleFrame(frame);
    const heard: ChannelMessage[] = [];
    adapter.onInbound((message) => void heard.push(channelMessageOf(message, "slack_app")));
    await adapter.start();
    await onFrame!(dm(1, "D_GUARDIAN", INSTALLER));
    await onFrame!(dm(2, "D_MEMBER", "U_MEMBER"));
    expect(heard).toHaveLength(2);

    // Who a sender is comes from the account it spoke from, and an account
    // nobody holds is nobody.
    const enter = accountEntry({ db: testDb.db });
    const entryOf = async (message: ChannelMessage) =>
      (await enter({ platform: platformOf(message.channel), id: message.senderId })).kind;
    const [fromGuardian, fromMember] = heard;
    expect(await entryOf(fromGuardian)).toBe("entered");
    expect(await entryOf(fromMember)).toBe("unknown");
  });
});
