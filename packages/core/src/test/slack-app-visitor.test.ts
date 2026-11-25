// Who the Slack app connection answers as the guardian: only the member who
// signed in. Built in test/ because it crosses the connection, People and the
// turn's audience. The setup names that member as the guardian's account
// (`T_A/U_GUARDIAN`, pinned in integrations/slack-app.test.ts); here the
// registry's mapping of it is applied as the setup manager applies it, and
// direct messages from that member and from another are heard through the
// connection and read as the inbox reads them.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChannelMessage } from "@rome-os/app-runtime";
import { platformOf } from "@rome/api-types/platform";
import { messagingAudience } from "../agent/index.js";
import { SLACK_APP_KIND } from "../connections/integrations/slack-app.js";
import {
  depositSignature,
  SLACK_DEPOSIT_HEADER,
  SLACK_SIGNATURE_HEADER,
} from "../connections/kinds/slack-app/deposit.js";
import { type MailboxFrame, SlackAppAdapter } from "../connections/kinds/slack-app/slack-app.js";
import { appPersonMapping } from "../people/app-person-mapping.js";
import { applyGuardianMappingWithinTx, planGuardianMapping } from "../people/guardian-mapping.js";
import { DrizzlePeopleRepository } from "../people/infrastructure/drizzle-people-repository.js";
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
    const people = new DrizzlePeopleRepository(testDb.db);
    await people.createWithId("guardian", { displayName: "Ouou", bondLevel: "guardian" });
    // The setup's mapping of the member who signed in, as the setup manager
    // applies it.
    const platform = platformOf(SLACK_APP_KIND);
    const account = `${TEAM}/${INSTALLER}`;
    const plan = await planGuardianMapping(people, platform, account, { addOnly: true });
    testDb.db.transaction((tx) =>
      applyGuardianMappingWithinTx(tx, people, platform, account, plan),
    );

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

    // The inbox reads a sender's bond from People by the account it spoke
    // from, and a sender no link names is "other".
    const mapping = appPersonMapping(people);
    const bondOf = async (message: ChannelMessage) =>
      (await mapping.findByChannelUser(message.channel, message.senderId))?.bondLevel ?? "other";
    const [guardian, member] = heard;
    expect(await bondOf(guardian)).toBe("guardian");
    expect(await bondOf(member)).toBe("other");

    // So only the guardian's direct message runs as the guardian's own turn.
    const audienceOf = async (message: ChannelMessage) =>
      messagingAudience(
        {
          channel: message.channel,
          threadId: message.chatId,
          threadType: "private",
          channelUserId: message.senderId,
          senderBondLevel: await bondOf(message),
        },
        SLACK_APP_KIND,
      );
    expect(await audienceOf(guardian)).toBe("private");
    expect(await audienceOf(member)).toBe("shared");
  });
});
