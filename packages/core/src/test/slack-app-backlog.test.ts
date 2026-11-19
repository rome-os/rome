// The whole graph a Slack app message passes through, so it is built here in
// test/ rather than in the connection.
//
// A backlog drained from the Slack app's mailbox, through everything that
// hears it: the registry, the inbound port, the chat adapter, recording and
// the hook. What this pins: of a backlog of 250 direct messages that waited in
// the mailbox while Rome was stopped, the connection's copy keeps every one
// and the mailbox lets go of each, none is handed over twice, and a slow
// direct message holds up no other.
//
// Not every message gets a turn: Rome's queue for a chat lets go of what waits
// past its capacity while a turn is slow, as it does for every kind, so an
// agent reads the chat to catch up rather than assume it saw every message.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Account, Channel, SaidInboundEvent } from "@rome-os/app-runtime";
import { chatsWiring } from "../chats-wiring.js";
import { connectionPorts } from "../chats/connected-accounts/connection-ports.js";
import { ChatEvents } from "../chats/storage/events.js";
import { inboundRecording } from "../connections/inbound-recording.js";
import { messagesSaid } from "../sessions/messages-said.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { createTestDb, type TestDb } from "./db.js";
import { ConnectionRegistry } from "../connections/registry.js";
import { DrizzleConnectionsRepository } from "../connections/repository-db.js";
import { makeSlackAppDescriptor } from "../connections/integrations/slack-app.js";
import { SLACK_APP_KIND } from "../connections/integrations/slack-app.js";
import {
  FORWARD_SIGNATURE_HEADER,
  FORWARD_TEAM_HEADER,
  FORWARD_TIMESTAMP_HEADER,
  forwardSignature,
} from "../connections/kinds/slack-app/forward.js";
import { slackAppMessages } from "../db/schema.js";
import { SlackMessageCopyRepository } from "../connections/kinds/slack-app/message-copy.js";
import type { MailboxFrame, OpenMailbox } from "../connections/kinds/slack-app/slack-app.js";

const TEAM = "T_A";
const BOT = "U_BOT";
const SECRET = "forward-secret-a";
const ROME: Account = { platform: "slack", id: `${TEAM}/${BOT}` };

function dm(i: number, channel: string, user: string) {
  const body = new TextEncoder().encode(
    JSON.stringify({
      type: "event_callback",
      team_id: TEAM,
      api_app_id: "A_ROME",
      event_id: `Ev${channel}${i}`,
      event: {
        type: "message",
        channel_type: "im",
        channel,
        user,
        text: `${channel} message ${i}`,
        ts: `1700000000.${String(i).padStart(6, "0")}`,
      },
    }),
  );
  const timestamp = "1700000000";
  return {
    headers: {
      "content-type": "application/json",
      [FORWARD_TEAM_HEADER]: TEAM,
      [FORWARD_TIMESTAMP_HEADER]: timestamp,
      [FORWARD_SIGNATURE_HEADER]: forwardSignature({
        forwardSecret: SECRET,
        timestamp,
        teamId: TEAM,
        body,
      }),
    },
    body,
  } satisfies MailboxFrame;
}

/** A relay mailbox holding what arrived while Rome was stopped. Opening a
 *  drain replays it in order, one frame at a time, as the relay does. */
function heldMailbox(frames: MailboxFrame[]) {
  const queue = [...frames];
  let drained!: () => void;
  const empty = new Promise<void>((resolve) => {
    drained = resolve;
  });
  const open: OpenMailbox = (_mailbox, onFrame) => {
    let open = true;
    void (async () => {
      while (open && queue.length > 0) {
        const { status } = await onFrame(queue[0]);
        if (status >= 500) return;
        queue.shift();
      }
      drained();
    })();
    return {
      stop: () => {
        open = false;
      },
    };
  };
  return { open, empty, left: () => queue.length };
}

describe("a Slack app backlog, end to end", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => testDb.close());

  async function connect(mailbox: ReturnType<typeof heldMailbox>) {
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
    });
    registry.register(
      makeSlackAppDescriptor({
        api: {
          authTest: async () => ({ teamId: TEAM, botUserId: BOT, appId: "A_ROME" }),
          postMessage: async () => ({ ts: "9.0" }),
          openDirectMessage: async () => "D_NEW",
          userName: async () => ({ displayName: "Member" }),
          conversationHistory: async () => ({ messages: [], hasMore: false }),
          conversationReplies: async () => ({ messages: [] }),
          memberChannels: async () => ({ channels: [] }),
          revoke: async () => {},
        },
        cloud: {} as never,
        openMailbox: mailbox.open,
        copy: new SlackMessageCopyRepository(testDb.db),
      }),
    );
    const ports = connectionPorts(
      { registry, channelOf: (connection) => connection.connectionKind },
      SLACK_APP_KIND,
    );
    if (!ports) throw new Error("the Slack app has no talker");
    const channel: Channel = { name: SLACK_APP_KIND, send: ports.send, inbound: ports.inbound };
    const wiring = chatsWiring(testDb.db, {
      accountOf: () => ROME,
      platformOfChannel: () => "slack",
      channelsOn: () => [SLACK_APP_KIND],
    });
    const events = new ChatEvents();
    const said = messagesSaid({
      chats: wiring.chats,
      sessions: new ChatsWebChatRepository(testDb.db),
      recording: inboundRecording(
        { chats: wiring.chats, messages: wiring.messages, events, adapters: wiring.adapters },
        [channel],
      ),
      events,
      wakes: wiring.links,
    });
    const connection = await registry.connect(SLACK_APP_KIND);
    const grant = async () =>
      registry.giveGrant(connection.connectionKind, connection.id, "bot", {
        material: {
          teamId: TEAM,
          botUserId: BOT,
          botToken: "xoxb-a",
          forwardSecret: SECRET,
          connectUrl: "wss://relay.test/c/mbx",
          drainKey: "k",
        },
        expiresAt: "never",
      });
    return { said, grant, settled: () => wiring.adapters.of(channel).settled() };
  }

  it("keeps each of 250 direct messages, hands none over twice, and holds up no other direct message", async () => {
    const backlog = [
      ...Array.from({ length: 250 }, (_, i) => dm(i, "D_BUSY", "U_BUSY")),
      dm(0, "D_OTHER", "U_OTHER"),
    ];
    const mailbox = heldMailbox(backlog);
    const { said, grant, settled } = await connect(mailbox);
    const answered = new Map<string, number>();
    let release!: () => void;
    const busy = new Promise<void>((resolve) => {
      release = resolve;
    });
    let otherAnswered = false;
    said.subscribe(async (event: SaidInboundEvent) => {
      const { chatId, messageId } = event.message;
      answered.set(`${chatId}/${messageId}`, (answered.get(`${chatId}/${messageId}`) ?? 0) + 1);
      if (chatId === "D_OTHER") otherAnswered = true;
      // The busy direct message's first answer takes a while.
      else if (messageId.endsWith(".000000")) await busy;
    });

    await grant();
    await mailbox.empty;
    for (let i = 0; i < 50 && !otherAnswered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(otherAnswered).toBe(true);
    release();
    await settled();
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    const kept = testDb.db.select().from(slackAppMessages).all();
    expect(kept.filter((row) => row.channelId === "D_BUSY")).toHaveLength(250);
    expect(kept.filter((row) => row.channelId === "D_OTHER")).toHaveLength(1);
    expect([...answered.values()].every((times) => times === 1)).toBe(true);
    expect(mailbox.left()).toBe(0);
  });
});
