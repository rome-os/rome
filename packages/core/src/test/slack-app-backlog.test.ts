// The whole graph a Slack app message passes through, so it is built here in
// test/ rather than in the connection.
//
// A backlog drained from the Slack app's mailbox, through everything that
// hears it: the registry, the inbound port, the chat adapter, recording and
// the hook. What this pins: of a backlog of 250 direct messages that waited in
// the mailbox while Rome was stopped, Chats records every one and the mailbox
// lets go of each only once it is on record, none is heard twice, and a slow
// turn in one direct message holds up neither the mailbox nor any other
// direct message.
//
// Not every message gets a turn: Rome's queue for a chat lets go of what waits
// past its capacity while a turn is slow, as it does for every kind, so an
// agent reads the chat to catch up rather than assume it saw every message.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Account, Channel, SaidInboundEvent } from "@rome-os/app-runtime";
import { chatsWiring } from "../chats-wiring.js";
import { connectionPorts } from "../chats/connected-accounts/connection-ports.js";
import { ChatEvents } from "../chats/storage/events.js";
import { type InboundRecording, inboundRecording } from "../connections/inbound-recording.js";
import { messagesSaid } from "../sessions/messages-said.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { createTestDb, type TestDb } from "./db.js";
import { ConnectionRegistry } from "../connections/registry.js";
import { DrizzleConnectionsRepository } from "../connections/repository-db.js";
import { makeSlackAppDescriptor } from "../connections/integrations/slack-app.js";
import { SLACK_APP_KIND } from "../connections/integrations/slack-app.js";
import {
  depositSignature,
  SLACK_DEPOSIT_HEADER,
  SLACK_SIGNATURE_HEADER,
} from "../connections/kinds/slack-app/deposit.js";
import { deliverSlackFrame } from "../connections/kinds/slack-app/drain.js";
import { chatMessages } from "../db/schema.js";
import type { MailboxFrame } from "../connections/kinds/slack-app/slack-app.js";

const TEAM = "T_A";
const BOT = "U_BOT";
const DEPOSIT_KEY = "deposit-key-a";
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
  return {
    headers: {
      "content-type": "application/json",
      [SLACK_DEPOSIT_HEADER]: "1",
      [SLACK_SIGNATURE_HEADER]: depositSignature(body, DEPOSIT_KEY),
    },
    body,
  } satisfies MailboxFrame;
}

/** The instance's relay mailbox holding what arrived while Rome was stopped.
 *  Opening a drain replays it in order, one frame at a time, as the relay
 *  does, delivering a frame again after a short wait while it is refused. */
function heldMailbox(frames: MailboxFrame[]) {
  const queue = [...frames];
  let drained!: () => void;
  const empty = new Promise<void>((resolve) => {
    drained = resolve;
  });
  const open = (onFrame: (frame: MailboxFrame) => Promise<{ status: number }>) => {
    void (async () => {
      while (queue.length > 0) {
        const { status } = await onFrame(queue[0]);
        if (status >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
        queue.shift();
      }
      drained();
    })();
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
          postMessage: async () => ({ ts: "9.0" }),
          openDirectMessage: async () => "D_NEW",
          addReaction: async () => {},
          removeReaction: async () => {},
          postEphemeral: async () => {},
          userName: async () => ({ displayName: "Member" }),
          conversationHistory: async () => ({ messages: [], hasMore: false }),
          conversationReplies: async () => ({ messages: [] }),
          memberChannels: async () => ({ channels: [] }),
        },
        cloud: {} as never,
        depositUrl: async () => null,
        deliveryAttempts: 4,
      }),
    );
    let recording: InboundRecording | undefined;
    const ports = connectionPorts(
      {
        registry,
        channelOf: (connection) => connection.connectionKind,
        entry: async () => ({ kind: "guardian", userId: "owner", via: "account" }),
        accepted: (on, ref) => recording?.accepted(on, ref) ?? Promise.resolve(),
      },
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
    recording = inboundRecording(
      {
        chats: wiring.chats,
        messages: wiring.messages,
        events,
        adapters: wiring.adapters,
        hold: (messageId) => {
          wiring.links.wakeUndecided(messageId);
          return () => wiring.links.wakeDecided(messageId);
        },
      },
      [channel],
    );
    const recorder = recording;
    const said = messagesSaid({
      chats: wiring.chats,
      sessions: new ChatsWebChatRepository(testDb.db),
      recording: recorder,
      events,
      wakes: wiring.links,
    });
    const connection = await registry.connect(SLACK_APP_KIND);
    const grant = async () => {
      await registry.giveGrant(connection.connectionKind, connection.id, "bot", {
        material: { teamId: TEAM, botUserId: BOT, depositKey: DEPOSIT_KEY },
        expiresAt: "never",
      });
      // The instance's drain hands every Slack frame to the connection.
      mailbox.open((frame) => deliverSlackFrame(registry, frame));
    };
    // Recorded, and every queued MessageSaid raised.
    return { said, grant, settled: () => recorder.settled() };
  }

  it("records each of 250 direct messages before the mailbox lets go of it, hears none twice, and lets a slow turn hold up nothing else", async () => {
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
    // The mailbox empties while the busy direct message's first turn still
    // runs: each frame is let go once its message is on record.
    await mailbox.empty;
    expect(mailbox.left()).toBe(0);
    const recorded = testDb.db.select().from(chatMessages).all();
    expect(
      recorded.map((row) => row.text).filter((text) => text.startsWith("D_BUSY")),
    ).toHaveLength(250);
    for (let i = 0; i < 50 && !otherAnswered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(otherAnswered).toBe(true);
    release();
    await settled();

    expect(testDb.db.select().from(chatMessages).all()).toHaveLength(251);
    expect([...answered.values()].every((times) => times === 1)).toBe(true);
  });
});
