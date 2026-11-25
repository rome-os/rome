// A Talker's delivery, through everything between it and Chats' record: the
// registry, the inbound port, the chat adapter and recording. What this pins
// is the rule in docs/domains/connections.md#message: a delivery settles once
// Chats has the message on record, so a connection tells its platform only
// then, and a listener still hearing a place's earlier message delays neither
// the record nor the settling of the next one. Built here in test/ because it
// spans the whole graph.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Account, Channel, ChatId } from "@rome-os/app-runtime";
import { chatsWiring } from "../chats-wiring.js";
import { connectionPorts } from "../chats/connected-accounts/connection-ports.js";
import { ChatEvents } from "../chats/storage/events.js";
import type { Message as ChatsMessage } from "../chats/storage/message.js";
import {
  type InboundRecording,
  inboundRecording,
  RAISES_BACKING_UP,
} from "../connections/inbound-recording.js";
import type * as connections from "../connections/message.js";
import { ConnectionRegistry } from "../connections/registry.js";
import { DrizzleConnectionsRepository } from "../connections/repository-db.js";
import { RecordingStopped } from "../connections/types.js";
import { legacyMessage, makePasteTalk } from "../connections/test-fixtures.js";
import { type UnknownSendersDeps, unknownSenders } from "../participation/unknown-senders.js";
import { createTestDb, type TestDb } from "./db.js";

const ROME: Account = { platform: "telegram", id: "rome-bot" };

function said(id: string, text = id, chat = "dm-1"): connections.Message {
  return legacyMessage({
    messageId: id,
    chatId: chat as ChatId,
    senderId: "7",
    senderDisplayName: "Chat",
    text,
    attachments: [],
    timestamp: new Date(),
    thread: { kind: "dm" },
  });
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
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

  async function connect(
    opts: {
      acceptTimeoutMs?: number;
      awaitsAcceptance?: boolean;
      /** Held until it resolves, before the channel hands a message over, as
       *  fetching its attachments would hold it. */
      handOver?: Promise<void>;
      /** Told of a message from a sender nobody holds, which every one is. */
      tell?: UnknownSendersDeps["tell"];
    } = {},
  ) {
    const logged: { level: string; message: string }[] = [];
    const note = (level: string) => (message: string) => void logged.push({ level, message });
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
      logger: {
        debug: note("debug"),
        info: note("info"),
        warn: note("warn"),
        error: note("error"),
      } as unknown as NonNullable<ConstructorParameters<typeof ConnectionRegistry>[0]["logger"]>,
    });
    const fx = makePasteTalk({ awaitsAcceptance: opts.awaitsAcceptance ?? true });
    registry.register(fx.descriptor);
    let recording: InboundRecording | undefined;
    const ports = connectionPorts(
      {
        registry,
        channelOf: (connection) => connection.connectionKind,
        accountOf: () => ROME,
        accepted: (channel, ref) => recording?.accepted(channel, ref) ?? Promise.resolve(),
        entry: async () => ({ kind: "unknown" }),
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
        // No wake to decide here: nothing reads catch-up.
        hold: () => () => {},
        adapters: {
          of: (on) => {
            const adapter = wiring.adapters.of(on);
            const { handOver } = opts;
            if (!handOver) return adapter;
            return Object.assign(Object.create(adapter) as typeof adapter, {
              start: (...[deliver, fault]: Parameters<typeof adapter.start>) =>
                adapter.start(async (message) => {
                  await handOver;
                  return deliver(message);
                }, fault),
            });
          },
        },
        onRecord: unknownSenders({
          isRomes: (account) => account.id === ROME.id,
          isOwnAccount: () => true,
          ...(opts.tell ? { tell: opts.tell } : {}),
        }),
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
    const forward = talker.state.deliver as (message: connections.Message) => unknown;
    return { deliver, forward, recorded, events, stop, logged, listen: () => recording!.listen() };
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

  it("settles a delivery without waiting for its unknown sender to be told, once on record", async () => {
    const told: string[] = [];
    const held = gate();
    const { deliver, recorded } = await connect({
      tell: async (message) => {
        told.push(`${message.platformMessageId} after ${recorded.length}`);
        await held.opened;
        throw new Error("not delivered");
      },
    });
    const addressed = { ...said("m1", "hello"), mentions: [] };
    await expect(deliver(addressed)).resolves.toBeUndefined();
    await expect(deliver(addressed)).resolves.toBeUndefined();
    const fromBot = { ...said("m2", "beep"), mentions: [] };
    await deliver({ ...fromBot, sender: { ...fromBot.sender, isBot: true } });
    const fromApp = { ...said("m3", "posted"), mentions: [] };
    await deliver({ ...fromApp, sender: { ...fromApp.sender, viaApp: true } });
    held.open();
    await settle();
    expect(told).toEqual(["m1 after 1"]);
    expect(recorded).toEqual(["hello", "beep", "posted"]);
  });

  it("resolves at once for a message with nothing to answer, which Chats never records", async () => {
    const { deliver, recorded } = await connect();
    await expect(deliver(said("empty", " "))).resolves.toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it("settles the next message in a place, and in another, while a listener still hears the one before", async () => {
    const { deliver, events, recorded } = await connect();
    const held = gate();
    events.subscribe(async () => held.opened);
    await expect(deliver(said("m1", "first"))).resolves.toBeUndefined();
    await expect(deliver(said("m2", "second"))).resolves.toBeUndefined();
    await expect(deliver(said("m3", "elsewhere", "dm-2"))).resolves.toBeUndefined();
    expect(recorded).toEqual(["first", "second", "elsewhere"]);
    held.open();
  });

  it("settles a place's next message however many raises wait there", async () => {
    const { deliver, events, recorded } = await connect();
    const held = gate();
    events.subscribe(async () => held.opened);
    for (let i = 0; i <= RAISES_BACKING_UP; i++) {
      await expect(deliver(said(`m${i}`))).resolves.toBeUndefined();
    }
    expect(recorded).toHaveLength(RAISES_BACKING_UP + 1);
    held.open();
  });

  it("rejects a message not recorded in time, and its delivery again is recorded once", async () => {
    const handingOver = gate();
    const { deliver, recorded } = await connect({
      acceptTimeoutMs: 50,
      handOver: handingOver.opened,
    });
    await expect(deliver(said("m1", "first"))).rejects.toThrow(/not recorded within 50ms/);
    handingOver.open();
    await settle();
    // A connection that was refused does not tell its platform, which
    // delivers the message again: Chats has it once.
    await expect(deliver(said("m1", "first"))).resolves.toBeUndefined();
    expect(recorded).toEqual(["first"]);
  });

  it("rejects what is still waiting when recording stops", async () => {
    const handingOver = gate();
    const { deliver, stop } = await connect({ handOver: handingOver.opened });
    const waiting = deliver(said("m1", "first"));
    await settle();
    stop();
    await expect(waiting).rejects.toBeInstanceOf(RecordingStopped);
    handingOver.open();
  });

  it("rejects a message that arrives while nobody records, as during a hook swap", async () => {
    const { deliver, recorded, stop, listen, logged } = await connect();
    stop();
    await expect(deliver(said("m1", "while away"))).rejects.toBeInstanceOf(RecordingStopped);
    expect(recorded).toEqual([]);
    // A refusal, not a handler bug: nothing is logged as an error.
    expect(logged.filter((entry) => entry.level === "error")).toEqual([]);
    // Delivered again once recording is back, it is on record once.
    listen();
    await expect(deliver(said("m1", "while away"))).resolves.toBeUndefined();
    expect(recorded).toEqual(["while away"]);
  });

  it("gives a Talker that does not wait nothing to wait on, while its message is still recording", async () => {
    const { forward, events, recorded } = await connect({ awaitsAcceptance: false });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    events.subscribe(async () => held);
    expect(forward(said("m1", "first"))).toBeUndefined();
    // The chat's next message waits behind the first one's listener, and the
    // Talker that forwarded it is not held.
    expect(forward(said("m2", "second"))).toBeUndefined();
    release();
    await settle();
    expect(recorded).toEqual(["first", "second"]);
  });
});
