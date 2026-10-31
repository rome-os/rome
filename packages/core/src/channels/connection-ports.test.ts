import { describe, expect, it } from "@rstest/core";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import {
  connectionPorts,
  recordedChannelOf,
  type ConnectionPortsDeps,
} from "./connection-ports.js";
import { ChannelNotConnected } from "./channel.js";
import { ConnectionRegistry } from "../connections/registry.js";
import { DrizzleConnectionsRepository } from "../connections/repository-db.js";
import { makePasteTalk } from "../connections/test-fixtures.js";
import { createTestDb, kindChannelOf } from "../test/helpers.js";
import { systemClock } from "../lib/clock.js";
import { ConnectionPacing } from "./delivery/connection-pacing.js";
import { ReplyDelivery } from "./delivery/reply.js";
import { type PartReceipt, plainText } from "./delivery/types.js";

const HOUR = 3_600_000;

function said(id: string, chatId: string, hoursAgo: number): ChannelMessage {
  return {
    channel: "telegram_user",
    direction: "inbound",
    messageId: id,
    chatId: chatId as ChatId,
    senderId: "7",
    senderDisplayName: "Chat",
    text: id,
    attachments: [],
    timestamp: new Date(Date.now() - hoursAgo * HOUR),
    thread: { kind: chatId === "group-1" ? "group" : "dm" },
  };
}

describe("connection-backed send, across epochs", () => {
  it("keeps a held direct port on whichever talker is live", async () => {
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(createTestDb().db),
    });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    const connection = await registry.connect("fake-telegram");
    const offerDirect = (answer: string) => {
      const talker = fx.talkerFactory.instances.at(-1);
      if (!talker) throw new Error("talker not built");
      talker.directMessaging = { chatFor: async () => answer as ChatId };
    };
    await registry.giveGrant(connection.connectionKind, connection.id, "bot", fx.validCredential());
    offerDirect("first");
    const direct = connectionPorts({ registry, channelOf: kindChannelOf }, "fake-telegram")?.send
      ?.direct;
    if (!direct) throw new Error("the talker offers direct messaging");
    await expect(direct.chatFor("7")).resolves.toBe("first");
    await expect(direct.conversationFor("7")).resolves.toBe("first");

    await connection.auth.revoke("bot");
    await expect(direct.chatFor("7")).rejects.toBeInstanceOf(ChannelNotConnected);

    await registry.giveGrant(connection.connectionKind, connection.id, "bot", fx.validCredential());
    offerDirect("second");
    await expect(direct.chatFor("7")).resolves.toBe("second");
  });
});

describe("connection ports for a service's later channels", () => {
  it("hears and sends on each channel through its own Connection", async () => {
    const { db } = createTestDb();
    const registry = new ConnectionRegistry({ repository: new DrizzleConnectionsRepository(db) });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    const first = await registry.connect("fake-telegram");
    const second = await registry.connectAnother("fake-telegram");
    const names = new Map([
      [first.id, "fake-telegram"],
      [second.id, "fake-telegram-2"],
    ]);
    // Only the second has reported the account it reaches.
    const account = { platform: "telegram", id: "8123" };
    const deps: ConnectionPortsDeps = {
      registry,
      channelOf: (connection) => names.get(connection.id) ?? connection.connectionKind,
      accountOf: (connectionId) => (connectionId === second.id ? account : null),
    };
    const ports = {
      first: connectionPorts(deps, "fake-telegram"),
      second: connectionPorts(deps, "fake-telegram", "fake-telegram-2"),
    };
    const heard: Array<{ channel: string; account?: unknown; connectionId: string }> = [];
    for (const port of Object.values(ports)) {
      port?.inbound?.subscribe(async (event) => {
        const { channel, account } = event.message;
        heard.push({
          channel,
          ...(account ? { account } : {}),
          connectionId: event.ref.connectionId,
        });
      });
    }
    await registry.giveGrant(first.connectionKind, first.id, "bot", fx.validCredential());
    const firstTalker = fx.talkerFactory.instances.at(-1)!;
    await registry.giveGrant(second.connectionKind, second.id, "bot", fx.validCredential());
    const secondTalker = fx.talkerFactory.instances.at(-1)!;

    secondTalker.state.deliver?.({ ...said("m1", "dm-1", 0), channel: "fake-telegram" });
    firstTalker.state.deliver?.({ ...said("m2", "dm-1", 0), channel: "fake-telegram" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual([
      { channel: "fake-telegram-2", account, connectionId: second.id },
      { channel: "fake-telegram", connectionId: first.id },
    ]);

    await ports.second?.send?.send("dm-1" as ChatId, { text: "hi" });
    expect(secondTalker.state.sends).toHaveLength(1);
    expect(firstTalker.state.sends).toHaveLength(0);
  });
});

describe("what a sender called themselves", () => {
  it("is heard for every inbound message, named by the channel and account it arrived on", async () => {
    const { db } = createTestDb();
    const registry = new ConnectionRegistry({ repository: new DrizzleConnectionsRepository(db) });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    const connection = await registry.connect("fake-telegram");
    const account = { platform: "telegram", id: "8123" };
    const heard: ChannelMessage[] = [];
    const ports = connectionPorts(
      {
        registry,
        channelOf: (each) => each.connectionKind,
        accountOf: () => account,
        heard: (message) => heard.push(message),
      },
      "fake-telegram",
    );
    const answered: string[] = [];
    ports?.inbound?.subscribe(async (event) => {
      answered.push(event.message.messageId);
    });
    await registry.giveGrant(connection.connectionKind, connection.id, "bot", fx.validCredential());
    const talker = fx.talkerFactory.instances.at(-1)!;

    talker.state.deliver?.(said("m1", "dm-1", 0));
    // Nothing to answer, but it still says who sent it.
    talker.state.deliver?.({ ...said("m2", "dm-1", 0), text: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      heard.map(({ messageId, channel, account, senderDisplayName }) => ({
        messageId,
        channel,
        account,
        senderDisplayName,
      })),
    ).toEqual([
      { messageId: "m1", channel: "fake-telegram", account, senderDisplayName: "Chat" },
      { messageId: "m2", channel: "fake-telegram", account, senderDisplayName: "Chat" },
    ]);
    expect(answered).toEqual(["m1"]);
  });
});

describe("a Connection Rome does not listen to", () => {
  function setup(listenedAtFirst: boolean) {
    const { db } = createTestDb();
    const registry = new ConnectionRegistry({ repository: new DrizzleConnectionsRepository(db) });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    let listened = listenedAtFirst;
    const listeners: Array<(connectionId: string) => void> = [];
    // The service's one Connection, once connected.
    const held = () => registry.find("fake-telegram")[0]?.id;
    const admitted: string[] = [];
    const deps: ConnectionPortsDeps = {
      registry,
      channelOf: kindChannelOf,
      admit: async (_connectionId, _service, message) => {
        admitted.push(message.messageId);
        return true;
      },
      listening: {
        listens: (connectionId) => connectionId === held() && listened,
        onChange: (listener) => listeners.push(listener),
      },
    };
    const ports = connectionPorts(deps, "fake-telegram")!;
    const heard: string[] = [];
    ports.inbound!.subscribe(async (event) => {
      heard.push(event.message.messageId);
    });
    const listen = (to: boolean, connectionId = held() ?? "") => {
      listened = to;
      for (const listener of listeners) listener(connectionId);
    };
    const deliver = async (id: string) => {
      fx.talkerFactory.instances.at(-1)!.state.deliver!({
        ...said(id, "dm-1", 0),
        channel: "fake-telegram",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { registry, fx, ports, heard, admitted, listen, deliver };
  }

  it("hears nothing, not even admission, until it is listened to", async () => {
    const { registry, fx, heard, admitted, listen, deliver } = setup(false);
    const connection = await registry.connect("fake-telegram");
    await registry.giveGrant(connection.connectionKind, connection.id, "bot", fx.validCredential());

    await deliver("before");
    expect(heard).toEqual([]);
    expect(admitted).toEqual([]);

    listen(true);
    await deliver("after");
    expect(heard).toEqual(["after"]);
    expect(admitted).toEqual(["after"]);
  });

  it("stops hearing when it stops being listened to, and starts again", async () => {
    const { registry, fx, heard, listen, deliver } = setup(true);
    const connection = await registry.connect("fake-telegram");
    await registry.giveGrant(connection.connectionKind, connection.id, "bot", fx.validCredential());

    await deliver("m1");
    listen(false);
    await deliver("m2");
    listen(true);
    // A second change to the same answer adds no second subscription.
    listen(true);
    await deliver("m3");

    expect(heard).toEqual(["m1", "m3"]);
  });

  it("ignores a change to another Connection", async () => {
    const { registry, fx, heard, listen, deliver } = setup(false);
    const connection = await registry.connect("fake-telegram");
    await registry.giveGrant(connection.connectionKind, connection.id, "bot", fx.validCredential());

    listen(true, "another-connection");
    await deliver("m1");

    expect(heard).toEqual([]);
  });

  it("sends whether or not it is listened to", async () => {
    const { registry, fx, ports } = setup(false);
    const connection = await registry.connect("fake-telegram");
    await registry.giveGrant(connection.connectionKind, connection.id, "bot", fx.validCredential());

    await ports.send!.send("dm-1" as ChatId, { text: "hi" });

    expect(fx.talkerFactory.instances.at(-1)!.state.sends).toHaveLength(1);
  });

  it("starts listening on a Connection that unlocks after it was listened to", async () => {
    const { registry, fx, heard, listen, deliver } = setup(false);
    const connection = await registry.connect("fake-telegram");
    listen(true);
    await registry.giveGrant(connection.connectionKind, connection.id, "bot", fx.validCredential());

    await deliver("m1");

    expect(heard).toEqual(["m1"]);
  });
});

describe("a Connection with no channel record", () => {
  it("backs no channel, not even its service's first", async () => {
    const { db } = createTestDb();
    const registry = new ConnectionRegistry({ repository: new DrizzleConnectionsRepository(db) });
    const fx = makePasteTalk();
    registry.register(fx.descriptor);
    // The service's only Connection, so nothing else could back the channel.
    const unrecorded = await registry.connect("fake-telegram");
    const deps: ConnectionPortsDeps = {
      registry,
      channelOf: recordedChannelOf({ idOf: () => null }, () => true),
    };
    const ports = connectionPorts(deps, "fake-telegram")!;
    const heard: string[] = [];
    ports.inbound!.subscribe(async (event) => {
      heard.push(event.ref.connectionId);
    });
    await registry.giveGrant(unrecorded.connectionKind, unrecorded.id, "bot", fx.validCredential());
    const talker = fx.talkerFactory.instances.at(-1)!;

    talker.state.deliver!({ ...said("m1", "dm-1", 0), channel: "fake-telegram" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual([]);
    await expect(ports.send!.send("dm-1" as ChatId, { text: "hi" })).rejects.toBeInstanceOf(
      ChannelNotConnected,
    );
    expect(talker.state.sends).toHaveLength(0);
    for (const lookup of [ports.send!.direct!.chatFor, ports.send!.direct!.conversationFor]) {
      await expect(lookup("7")).rejects.toBeInstanceOf(ChannelNotConnected);
    }
  });
});

describe("reply streaming ports", () => {
  const budget = { burst: 100, refillMs: 1, conversationSpacingMs: 0 };

  /**
   * A Connection whose talker sends, and streams when `streams` is set. Its
   * first send waits to be released, so a test can see whether the second
   * send starts before the first ends.
   */
  function portsFor({ pacing, streams = true }: { pacing?: ConnectionPacing; streams?: boolean }) {
    const sent: string[] = [];
    /** The messages the talker was asked to settle, with their text. */
    const settled: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const live = { talker: true };
    const talker = {
      async send(_conversation: string, message: { text?: string }) {
        sent.push(`start ${message.text}`);
        if (message.text === "first") await gate;
        sent.push(`end ${message.text}`);
        return { chatId: "chat-1" };
      },
      ...(streams
        ? {
            replyDelivery: {
              capabilities: { maxPartLength: 10, edit: false, budget },
              codec: plainText,
              create: async () => ({ messageId: "m1", chatId: "chat-1", streaming: true as const }),
              settle: async (receipt: PartReceipt, text: string) => {
                settled.push(`${receipt.messageId} ${text}`);
              },
            },
          }
        : {}),
    };
    const connection = {
      id: "conn-1",
      service: "telegram",
      withTalker: (call: (talker: object) => unknown) => (live.talker ? call(talker) : undefined),
      hearTalker: () => () => {},
    };
    const deps = {
      registry: {
        getDescriptor: () => ({ capabilities: { talker: {} } }),
        find: () => [connection],
        onUnlocked: () => {},
        registeredKinds: () => ["telegram"],
      },
      channelOf: (each: { service: string }) => each.service,
      ...(pacing ? { pacing } : {}),
    } as unknown as ConnectionPortsDeps;
    return { send: connectionPorts(deps, "telegram")!.send!, sent, settled, release, live };
  }

  const pacingWith = (on: boolean) => new ConnectionPacing(systemClock, async () => on);
  const chat = "chat-1" as ChatId;
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("offers no replies port without pacing, or from a talker that cannot stream", () => {
    expect(portsFor({}).send.replies).toBeNull();
    expect(portsFor({ pacing: pacingWith(true), streams: false }).send.replies).toBeNull();
  });

  it("offers the replies port whether or not reply streaming is on, since the caller reads the setting", () => {
    expect(portsFor({ pacing: pacingWith(false) }).send.replies).not.toBeNull();
  });

  it("paces ordinary sends one at a time while reply streaming is on", async () => {
    const { send, sent, release } = portsFor({ pacing: pacingWith(true) });
    const first = send.send(chat, { text: "first" });
    const second = send.send(chat, { text: "second" });
    await tick();
    expect(sent).toEqual(["start first"]);
    release();
    await Promise.all([first, second]);
    expect(sent).toEqual(["start first", "end first", "start second", "end second"]);
  });

  it("sends at once while reply streaming is off", async () => {
    const { send, sent, release } = portsFor({ pacing: pacingWith(false) });
    const first = send.send(chat, { text: "first" });
    const second = send.send(chat, { text: "second" });
    await tick();
    expect(sent).toEqual(["start first", "start second", "end second"]);
    release();
    await Promise.all([first, second]);
  });

  it("writes a reply through the live talker, and refuses while talk is locked", async () => {
    const { send, live } = portsFor({ pacing: pacingWith(true) });
    const replies = send.replies!;
    await expect(replies.transport.create("chat-1", "hi")).resolves.toEqual({
      messageId: "m1",
      chatId: "chat-1",
      streaming: true,
    });
    live.talker = false;
    await expect(replies.transport.create("chat-1", "hi")).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("settles a streamed reply's message through the live talker", async () => {
    const { send, settled } = portsFor({ pacing: pacingWith(true) });
    const replies = send.replies!;
    const delivery = new ReplyDelivery({
      transport: replies.transport,
      pacer: replies.pacer,
      policy: { mode: "blocks", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 100 },
      conversation: "chat-1",
      clock: systemClock,
    });
    delivery.accept({ type: "text", content: "hi there" });

    expect((await delivery.finish()).status).toBe("delivered");
    expect(settled).toEqual(["m1 hi there"]);
  });
});
