import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ConversationId,
  InboundMessage,
  TalkActivity,
  TalkDirectMessaging,
} from "@rome-os/app-runtime";
import { ConnectionRegistry } from "../connections/registry.js";
import { DrizzleGrantLedger } from "../connections/ledger-db.js";
import { tokenPaste } from "../connections/schemes.js";
import { createTalkRouter } from "../connections/talk-router.js";
import type { ConnectionDescriptor, Talker } from "../connections/types.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import type { Accounts } from "./accounts.js";
import { ChannelNotConnected, type InboundEvent } from "./channel.js";
import { channelList } from "./channel-list.js";

const noAccounts: Accounts = {
  listAccounts: async () => ({ accounts: [] }),
  resolve: async () => null,
};

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "m-1",
    conversationId: "c-1" as ConversationId,
    senderId: "guardian",
    text: "hello",
    attachments: [],
    timestamp: new Date(0),
    ...overrides,
  };
}

/** A pasted-token service whose every talker epoch is recorded. */
function talkService(
  service: string,
  ports: { sends?: boolean; receives?: boolean } = {},
  direct: TalkDirectMessaging | null = null,
  activity: TalkActivity | null = null,
): { descriptor: ConnectionDescriptor; epochs: Array<{ deliver?: (m: InboundMessage) => void }> } {
  const epochs: Array<{ deliver?: (m: InboundMessage) => void }> = [];
  return {
    epochs,
    descriptor: {
      service,
      auth: { bot: tokenPaste({ label: "token", validate: async () => {} }) },
      capabilities: {
        talker: {
          needs: ["bot"],
          ...ports,
          build(): Talker {
            const epoch: (typeof epochs)[number] = {};
            epochs.push(epoch);
            return {
              start(deliver) {
                epoch.deliver = deliver;
              },
              stop() {},
              async send(conversationId) {
                return { conversationId, messageId: `sent-${epochs.length}` };
              },
              feature: ((name: string) =>
                name === "directMessaging"
                  ? direct
                  : name === "activity"
                    ? activity
                    : null) as Talker["feature"],
            };
          },
        },
      },
    },
  };
}

describe("channelList", () => {
  let testDb: TestDb | undefined;
  afterEach(() => testDb?.close());

  function setup(
    descriptors: ConnectionDescriptor[],
    admit = async (_id: string, _service: string, inbound: InboundMessage) =>
      inbound.senderId === "guardian",
    routerOptions?: { admissionTimeoutMs?: number },
  ) {
    testDb = createTestDb();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(testDb.db) });
    for (const descriptor of descriptors) registry.register(descriptor);
    const talkRouter = createTalkRouter(registry, admit, routerOptions);
    // The Connection ids the channel ports hold a router subscription on.
    const subscribed: string[] = [];
    const router: typeof talkRouter = Object.assign(Object.create(talkRouter), {
      subscribe(connectionId: string, handler: (message: InboundMessage) => Promise<void>) {
        subscribed.push(connectionId);
        const detach = talkRouter.subscribe(connectionId, handler);
        return () => {
          subscribed.splice(subscribed.indexOf(connectionId), 1);
          detach();
        };
      },
    });
    const channels = channelList({
      db: testDb.db,
      whatsAppAccounts: noAccounts,
      linkedInAccounts: noAccounts,
      connections: { registry, router },
    });
    return { registry, channels, subscribed };
  }

  it("gives every service with a Talk a channel, beside the read-backed ones", () => {
    const actOnly: ConnectionDescriptor = {
      service: "github",
      auth: {},
      capabilities: {
        actor: { needs: [], build: () => ({ operations: () => [], invoke: async () => null }) },
      },
    };
    const { channels } = setup([
      talkService("whatsapp").descriptor,
      talkService("linkedin", { receives: false }).descriptor,
      talkService("telegram").descriptor,
      talkService("silent", { sends: false, receives: false }).descriptor,
      actOnly,
    ]);

    expect(channels.map((channel) => channel.name)).toEqual(["whatsapp", "linkedin", "telegram"]);
    const [whatsapp, linkedin, telegram] = channels;
    expect(whatsapp).toMatchObject({ accounts: noAccounts });
    expect(whatsapp?.send).not.toBeNull();
    expect(whatsapp?.inbound).not.toBeNull();
    expect(linkedin?.send).not.toBeNull();
    expect(linkedin?.inbound).toBeNull();
    expect(telegram).toMatchObject({ accounts: null, messages: null });
  });

  it("rejects a send nothing backs, and sends through the Connection once one does", async () => {
    const { registry, channels } = setup([talkService("telegram").descriptor]);
    const telegram = channels.find((channel) => channel.name === "telegram")!;

    await expect(telegram.send!.send("c-1" as ConversationId, { text: "hi" })).rejects.toThrow(
      'No connection backs channel "telegram"',
    );

    const connection = await registry.connect("telegram");
    await registry.importCredential(connection.id, "bot", {
      material: { token: "t" },
      expiresAt: "never",
    });
    await expect(
      telegram.send!.send("c-1" as ConversationId, { text: "hi" }),
    ).resolves.toMatchObject({ messageId: "sent-1" });
  });

  it("reaches an account directly only through a Connection that offers it", async () => {
    const conversationFor = rs.fn(async (id: string) => id as ConversationId);
    const { registry, channels } = setup([
      talkService("telegram", {}, { conversationFor }).descriptor,
      talkService("discord").descriptor,
    ]);
    const telegram = channels.find((channel) => channel.name === "telegram")!;
    const discord = channels.find((channel) => channel.name === "discord")!;

    // Nothing backs either channel yet: the lookup says so, as a send would.
    await expect(telegram.send!.direct!.conversationFor("u-1")).rejects.toBeInstanceOf(
      ChannelNotConnected,
    );

    for (const service of ["telegram", "discord"]) {
      const connection = await registry.connect(service);
      await registry.importCredential(connection.id, "bot", {
        material: { token: "t" },
        expiresAt: "never",
      });
    }
    await expect(telegram.send!.direct!.conversationFor("u-1")).resolves.toBe("u-1");
    // A Connection whose talker offers no direct messaging.
    expect(discord.send!.direct).toBeNull();
  });

  it("shows typing through the send port once a Connection offers it", async () => {
    const begin = rs.fn(async () => null);
    const { registry, channels } = setup([talkService("telegram", {}, null, { begin }).descriptor]);
    const send = channels.find((channel) => channel.name === "telegram")!.send!;

    expect(send.activity).toBeNull();
    const connection = await registry.connect("telegram");
    await registry.importCredential(connection.id, "bot", {
      material: { token: "t" },
      expiresAt: "never",
    });
    await send.activity!.begin({ conversationId: "c-1" as ConversationId });
    expect(begin).toHaveBeenCalledWith({ conversationId: "c-1" });
  });

  it("delivers admitted, answerable messages to a subscription that outlives reconnects", async () => {
    const service = talkService("telegram");
    const { registry, channels } = setup([service.descriptor]);
    const telegram = channels.find((channel) => channel.name === "telegram")!;

    // Subscribed before any Connection exists.
    const heard: InboundEvent[] = [];
    const failing = rs.fn(async () => {
      throw new Error("boom");
    });
    telegram.inbound!.subscribe(failing);
    telegram.inbound!.subscribe(async (event) => {
      heard.push(event);
    });

    const connection = await registry.connect("telegram");
    const grant = { material: { token: "first" }, expiresAt: "never" as const };
    await registry.importCredential(connection.id, "bot", grant);
    service.epochs[0]!.deliver?.(message({ messageId: "stranger", senderId: "unknown" }));
    service.epochs[0]!.deliver?.(message({ messageId: "empty", text: "  " }));
    service.epochs[0]!.deliver?.(message({ messageId: "first" }));
    await rs.waitFor(() => expect(heard.map((e) => e.message.messageId)).toEqual(["first"]));
    expect(heard[0]?.kind).toBe("message");
    expect(heard[0]?.ref).toEqual({ connectionId: connection.id, conversationId: "c-1" });
    expect(failing).toHaveBeenCalledTimes(1);

    await connection.auth.revoke("bot");
    await registry.importCredential(connection.id, "bot", { ...grant, material: { token: "2" } });
    service.epochs[1]!.deliver?.(message({ messageId: "second" }));
    await rs.waitFor(() =>
      expect(heard.map((e) => e.message.messageId)).toEqual(["first", "second"]),
    );
  });

  it("keeps two subscriptions of one handler independent", async () => {
    const service = talkService("telegram");
    const { registry, channels } = setup([service.descriptor]);
    const inbound = channels.find((channel) => channel.name === "telegram")!.inbound!;
    const heard: string[] = [];
    const handler = async (event: InboundEvent) => {
      heard.push(event.message.messageId);
    };
    const first = inbound.subscribe(handler);
    inbound.subscribe(handler);

    const connection = await registry.connect("telegram");
    await registry.importCredential(connection.id, "bot", {
      material: { token: "t" },
      expiresAt: "never",
    });
    service.epochs[0]!.deliver?.(message({ messageId: "both" }));
    await rs.waitFor(() => expect(heard).toEqual(["both", "both"]));

    first();
    service.epochs[0]!.deliver?.(message({ messageId: "second only" }));
    await rs.waitFor(() => expect(heard).toEqual(["both", "both", "second only"]));
  });

  it("follows a Connection removed and connected again, holding only the live one", async () => {
    const service = talkService("telegram");
    const { registry, channels, subscribed } = setup([service.descriptor]);
    const inbound = channels.find((channel) => channel.name === "telegram")!.inbound!;
    const heard: string[] = [];
    inbound.subscribe(async (event) => {
      heard.push(event.message.messageId);
    });
    const grant = { material: { token: "t" }, expiresAt: "never" as const };

    const first = await registry.connect("telegram");
    await registry.importCredential(first.id, "bot", grant);
    await registry.remove(first.id);
    const second = await registry.connect("telegram");
    await registry.importCredential(second.id, "bot", grant);
    service.epochs[1]!.deliver?.(message({ messageId: "after reconnect" }));

    await rs.waitFor(() => expect(heard).toEqual(["after reconnect"]));
    expect(subscribed).toEqual([second.id]);
  });

  it("hears one conversation's events in order, without waiting on another conversation", async () => {
    const service = talkService("telegram");
    const { registry, channels } = setup([service.descriptor]);
    const inbound = channels.find((channel) => channel.name === "telegram")!.inbound!;
    const started: string[] = [];
    let releaseFirst!: () => void;
    inbound.subscribe(async (event) => {
      const id = event.message.messageId;
      started.push(id);
      if (id === "c1-first") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        throw new Error("first fails after it is released");
      }
    });

    const connection = await registry.connect("telegram");
    await registry.importCredential(connection.id, "bot", {
      material: { token: "t" },
      expiresAt: "never",
    });
    const deliver = service.epochs[0]!.deliver!;
    deliver(message({ messageId: "c1-first", conversationId: "c-1" as ConversationId }));
    deliver(message({ messageId: "c1-second", conversationId: "c-1" as ConversationId }));
    deliver(message({ messageId: "c2-first", conversationId: "c-2" as ConversationId }));

    // c-2 is heard while c-1's first event is still in its handler.
    await rs.waitFor(() => expect(started).toEqual(["c1-first", "c2-first"]));
    releaseFirst();
    // c-1's second event starts only once its first has settled, even though
    // that one failed.
    await rs.waitFor(() => expect(started).toEqual(["c1-first", "c2-first", "c1-second"]));
  });

  it("keeps a conversation's order when admission finishes out of order", async () => {
    const service = talkService("telegram");
    // Admission for the first message finishes after admission for the second,
    // as two pooled database queries can.
    const { registry, channels } = setup([service.descriptor], async (_id, _service, inbound) => {
      if (inbound.messageId === "one") await new Promise((resolve) => setTimeout(resolve, 30));
      return true;
    });
    const heard: string[] = [];
    channels
      .find((channel) => channel.name === "telegram")!
      .inbound!.subscribe(async (event) => {
        heard.push(event.message.messageId);
      });

    const connection = await registry.connect("telegram");
    await registry.importCredential(connection.id, "bot", {
      material: { token: "t" },
      expiresAt: "never",
    });
    service.epochs[0]!.deliver?.(message({ messageId: "one" }));
    service.epochs[0]!.deliver?.(message({ messageId: "two" }));
    await rs.waitFor(() => expect(heard).toEqual(["one", "two"]));
  });

  it("fails a stuck admission closed and admits the conversation's next message", async () => {
    const service = talkService("telegram");
    const { registry, channels } = setup(
      [service.descriptor],
      (_id, _service, inbound) =>
        inbound.messageId === "stuck" ? new Promise<boolean>(() => {}) : Promise.resolve(true),
      { admissionTimeoutMs: 30 },
    );
    const heard: string[] = [];
    channels
      .find((channel) => channel.name === "telegram")!
      .inbound!.subscribe(async (event) => {
        heard.push(event.message.messageId);
      });

    const connection = await registry.connect("telegram");
    await registry.importCredential(connection.id, "bot", {
      material: { token: "t" },
      expiresAt: "never",
    });
    service.epochs[0]!.deliver?.(message({ messageId: "stuck" }));
    service.epochs[0]!.deliver?.(message({ messageId: "next" }));
    await rs.waitFor(() => expect(heard).toEqual(["next"]));
  });

  it("drops events still queued for a handler once it unsubscribes", async () => {
    const service = talkService("telegram");
    const { registry, channels } = setup([service.descriptor]);
    const inbound = channels.find((channel) => channel.name === "telegram")!.inbound!;
    const started: string[] = [];
    let releaseFirst!: () => void;
    const unsubscribe = inbound.subscribe(async (event) => {
      started.push(event.message.messageId);
      if (event.message.messageId === "held") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    });

    const connection = await registry.connect("telegram");
    await registry.importCredential(connection.id, "bot", {
      material: { token: "t" },
      expiresAt: "never",
    });
    service.epochs[0]!.deliver?.(message({ messageId: "held" }));
    service.epochs[0]!.deliver?.(message({ messageId: "queued" }));
    await rs.waitFor(() => expect(started).toEqual(["held"]));

    unsubscribe();
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toEqual(["held"]);
  });

  it("lets no slow or synchronously throwing handler hold up another subscriber", async () => {
    const service = talkService("telegram");
    const { registry, channels } = setup([service.descriptor]);
    const inbound = channels.find((channel) => channel.name === "telegram")!.inbound!;

    // Never settles: a subscriber stuck on the first event.
    inbound.subscribe(() => new Promise<void>(() => {}));
    // Throws before it returns a promise.
    inbound.subscribe((() => {
      throw new Error("sync boom");
    }) as unknown as (event: InboundEvent) => Promise<void>);
    const heard: string[] = [];
    inbound.subscribe(async (event) => {
      heard.push(event.message.messageId);
    });

    const connection = await registry.connect("telegram");
    await registry.importCredential(connection.id, "bot", {
      material: { token: "t" },
      expiresAt: "never",
    });
    service.epochs[0]!.deliver?.(message({ messageId: "first" }));
    service.epochs[0]!.deliver?.(message({ messageId: "second" }));
    await rs.waitFor(() => expect(heard).toEqual(["first", "second"]));
  });
});
