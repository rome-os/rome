// A Talker's delivery, through everything between it and Chats' record: the
// registry, the inbound port, the chat adapter and recording. What this pins
// is the rule in docs/domains/connections.md#message: a delivery settles once
// Chats has the message on record, so a connection tells its platform only
// then. Built here in test/ because it spans the whole graph.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Account, Channel, ChatId } from "@rome-os/app-runtime";
import { chatsWiring } from "../chats-wiring.js";
import { connectionPorts } from "../chats/connected-accounts/connection-ports.js";
import { ChatEvents } from "../chats/storage/events.js";
import type { Message as ChatsMessage } from "../chats/storage/message.js";
import { type InboundRecording, inboundRecording } from "../connections/inbound-recording.js";
import type * as connections from "../connections/message.js";
import { ConnectionRegistry } from "../connections/registry.js";
import { DrizzleConnectionsRepository } from "../connections/repository-db.js";
import { RecordingStopped } from "../connections/types.js";
import { legacyMessage, makePasteTalk } from "../connections/test-fixtures.js";
import { createTestDb, type TestDb } from "./db.js";

const ROME: Account = { platform: "telegram", id: "rome-bot" };

function said(id: string, text = id): connections.Message {
  return legacyMessage({
    messageId: id,
    chatId: "dm-1" as ChatId,
    senderId: "7",
    senderDisplayName: "Chat",
    text,
    attachments: [],
    timestamp: new Date(),
    thread: { kind: "dm" },
  });
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("a delivery settles once Chats has the message on record", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => testDb.close());

  async function connect(opts: { acceptTimeoutMs?: number } = {}) {
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
    });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    let recording: InboundRecording | undefined;
    const ports = connectionPorts(
      {
        registry,
        channelOf: (connection) => connection.connectionKind,
        accountOf: () => ROME,
        accepted: (channel, ref) => recording?.accepted(channel, ref) ?? Promise.resolve(),
      },
      "fake-telegram",
    );
    if (!ports) throw new Error("the fake kind has no talker");
    const channel: Channel = { name: "fake-telegram", send: ports.send, inbound: ports.inbound };
    const wiring = chatsWiring(testDb.db, {
      accountOf: () => ROME,
      platformOfChannel: () => "telegram",
      channelsOn: () => ["fake-telegram"],
    });
    const recorded: string[] = [];
    const events = new ChatEvents();
    recording = inboundRecording(
      {
        chats: wiring.chats,
        messages: {
          record: (message: ChatsMessage) => {
            const answer = wiring.messages.record(message);
            // Only what is new on record: a redelivery records nothing.
            if (answer !== null) recorded.push(message.body.text);
            return answer;
          },
        },
        events,
        adapters: wiring.adapters,
        ...(opts.acceptTimeoutMs === undefined ? {} : { acceptTimeoutMs: opts.acceptTimeoutMs }),
      },
      [channel],
    );
    const stop = recording.listen();
    const connection = await registry.connect("fake-telegram");
    await registry.giveGrant(connection.connectionKind, connection.id, "bot", fx.validCredential());
    const talker = fx.talkerFactory.instances.at(-1);
    if (!talker?.state.deliver) throw new Error("the talker did not start");
    const deliver = talker.state.deliver as (message: connections.Message) => Promise<void>;
    return { deliver, recorded, events, stop };
  }

  it("resolves only after the message is recorded, and again for a redelivery already on record", async () => {
    const { deliver, recorded } = await connect();
    let settled = false;
    const delivery = deliver(said("m1", "hello")).then(() => {
      settled = true;
      return recorded.length;
    });
    expect(settled).toBe(false);
    await expect(delivery).resolves.toBe(1);

    await expect(deliver(said("m1", "hello"))).resolves.toBeUndefined();
    expect(recorded).toEqual(["hello"]);
  });

  it("resolves at once for a message with nothing to answer, which Chats never records", async () => {
    const { deliver, recorded } = await connect();
    await expect(deliver(said("empty", " "))).resolves.toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it("rejects a message not recorded in time, and its delivery again is recorded once", async () => {
    const { deliver, events, recorded } = await connect({ acceptTimeoutMs: 50 });
    // The chat's first message is heard by a listener that never finishes,
    // so its next one waits behind it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    events.subscribe(async () => held);
    const first = deliver(said("m1", "first"));
    await expect(first).resolves.toBeUndefined();
    await expect(deliver(said("m2", "second"))).rejects.toThrow(/not recorded within 50ms/);
    release();
    await settle();
    // A connection that was refused does not tell its platform, which
    // delivers the message again: Chats has it once.
    await expect(deliver(said("m2", "second"))).resolves.toBeUndefined();
    expect(recorded).toEqual(["first", "second"]);
  });

  it("rejects what is still waiting when recording stops", async () => {
    const { deliver, events, stop } = await connect();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    events.subscribe(async () => held);
    await deliver(said("m1", "first"));
    const waiting = deliver(said("m2", "second"));
    await settle();
    stop();
    await expect(waiting).rejects.toBeInstanceOf(RecordingStopped);
    release();
  });
});
