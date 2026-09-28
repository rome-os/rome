import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, InboundMessage } from "@rome-os/app-runtime";
import { ConnectionRegistry } from "../connections/registry.js";
import { DrizzleGrantLedger } from "../connections/ledger-db.js";
import { tokenPaste } from "../connections/schemes.js";
import { createTalkRouter } from "../connections/talk-router.js";
import type { ConnectionDescriptor, Talker } from "../connections/types.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import type { Accounts } from "./accounts.js";
import type { InboundEvent } from "./channel.js";
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
              feature: () => null,
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

  function setup(descriptors: ConnectionDescriptor[]) {
    testDb = createTestDb();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(testDb.db) });
    for (const descriptor of descriptors) registry.register(descriptor);
    const router = createTalkRouter(
      registry,
      async (_id, _service, inbound) => inbound.senderId === "guardian",
    );
    const channels = channelList({
      db: testDb.db,
      whatsAppAccounts: noAccounts,
      linkedInAccounts: noAccounts,
      connections: { registry, router },
    });
    return { registry, channels };
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
    expect(failing).toHaveBeenCalledTimes(1);

    await connection.auth.revoke("bot");
    await registry.importCredential(connection.id, "bot", { ...grant, material: { token: "2" } });
    service.epochs[1]!.deliver?.(message({ messageId: "second" }));
    await rs.waitFor(() =>
      expect(heard.map((e) => e.message.messageId)).toEqual(["first", "second"]),
    );
  });
});
