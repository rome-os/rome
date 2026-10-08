import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { DrizzleGrantLedger } from "../connections/ledger-db.js";
import { ConnectionRegistry } from "../connections/registry.js";
import { tokenPaste } from "../connections/schemes.js";
import type { ConnectionDescriptor, ChannelTransport } from "../connections/types.js";
import { connectionPorts } from "./connection-ports.js";

describe("a channel's Connection across epochs", () => {
  let testDb: TestDb | undefined;
  afterEach(() => testDb?.close());

  it.each([
    false,
    true,
  ])("keeps subscriptions and features on the current epoch with admission=%s", async (gated) => {
    testDb = createTestDb();
    const instances: Array<{
      deliver?: (message: ChannelMessage) => void;
      sends: string[];
      epoch: number;
    }> = [];
    const descriptor: ConnectionDescriptor = {
      service: "discord",
      auth: {
        bot: tokenPaste({ label: "token", validate: async () => {} }),
      },
      capabilities: {
        transport: {
          needs: ["bot"],
          build(): ChannelTransport {
            const state: (typeof instances)[number] = {
              sends: [],
              epoch: instances.length + 1,
            };
            instances.push(state);
            return {
              start(deliver) {
                state.deliver = deliver;
              },
              stop() {},
              async send(conversationId, message) {
                state.sends.push(message.text ?? "");
                return { conversationId, messageId: `sent-${state.epoch}` };
              },
              history: {
                query: async () => [
                  {
                    channel: "discord",
                    direction: "inbound",
                    messageId: `history-${state.epoch}`,
                    conversationId: "general" as ConversationId,
                    senderId: "guardian",
                    text: `epoch ${state.epoch}`,
                    attachments: [],
                    timestamp: new Date(0),
                  },
                ],
              },
            };
          },
        },
      },
    };
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(testDb.db) });
    registry.register(descriptor);
    const connection = await registry.connect("discord");
    const admit = rs.fn(
      async (_id: string, _service: string, message: ChannelMessage) =>
        message.senderId === "guardian",
    );
    const ports = connectionPorts({ registry, ...(gated ? { admit } : {}) }, "discord")!;
    const sibling: string[] = [];
    const unsubscribe = ports.inbound!.subscribe(async (event) => {
      sibling.push(event.message.messageId);
    });
    const received: string[] = [];
    ports.inbound!.subscribe(async (event) => {
      received.push(event.message.messageId);
    });

    await registry.importCredential(connection.id, "bot", {
      material: { token: "first" },
      expiresAt: "never",
    });
    instances[0]!.deliver?.({
      channel: "discord",
      direction: "inbound",
      messageId: "inbound-1",
      conversationId: "general" as ConversationId,
      senderId: "guardian",
      text: "hello",
      attachments: [],
      timestamp: new Date(0),
    });
    await rs.waitFor(() => expect(received).toEqual(["inbound-1"]));
    await rs.waitFor(() => expect(sibling).toEqual(["inbound-1"]));
    // Admission runs once per message, however many subscribe.
    if (gated) expect(admit).toHaveBeenCalledTimes(1);

    const history = await connection.withTransport((transport) =>
      transport.history?.query({ limit: 10 }),
    );
    expect(history?.[0]?.messageId).toBe("history-1");
    await expect(
      ports.send!.send("general" as ConversationId, { text: "first reply" }),
    ).resolves.toMatchObject({ messageId: "sent-1" });

    // Past its epoch nothing reaches the stopped transport.
    await connection.auth.revoke("bot");
    expect(connection.withTransport(() => "reached")).toBeUndefined();
    expect(connection.isUnlocked("talk")).toBe(false);
    await registry.importCredential(connection.id, "bot", {
      material: { token: "second" },
      expiresAt: "never",
    });
    instances[1]!.deliver?.({
      channel: "discord",
      direction: "inbound",
      messageId: "inbound-2",
      conversationId: "general" as ConversationId,
      senderId: "guardian",
      text: "hello again",
      attachments: [],
      timestamp: new Date(0),
    });
    await rs.waitFor(() => expect(received).toEqual(["inbound-1", "inbound-2"]));
    await rs.waitFor(() => expect(sibling).toEqual(received));
    if (gated) {
      expect(admit).toHaveBeenCalledTimes(2);
      instances[1]!.deliver?.({
        channel: "discord",
        direction: "inbound",
        messageId: "blocked",
        conversationId: "general" as ConversationId,
        senderId: "unknown",
        text: "not authorized",
        attachments: [],
        timestamp: new Date(),
      });
      await rs.waitFor(() => expect(admit).toHaveBeenCalledTimes(3));
      expect(received).toEqual(["inbound-1", "inbound-2"]);
    }
    unsubscribe();
    const current = await connection.withTransport((transport) =>
      transport.history?.query({ limit: 10 }),
    );
    expect(current?.[0]?.messageId).toBe("history-2");
    await expect(
      ports.send!.send("general" as ConversationId, { text: "second reply" }),
    ).resolves.toMatchObject({ messageId: "sent-2" });
  });

  it("admits a message even before anyone subscribes", async () => {
    testDb = createTestDb();
    let deliver: ((message: ChannelMessage) => void) | undefined;
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(testDb.db) });
    registry.register({
      service: "telegram",
      auth: { bot: tokenPaste({ label: "token", validate: async () => {} }) },
      capabilities: {
        transport: {
          needs: ["bot"],
          build: (): ChannelTransport => ({
            start(next) {
              deliver = next;
            },
            stop() {},
            send: async (conversationId) => ({ conversationId }),
          }),
        },
      },
    });
    const admit = rs.fn(async () => false);
    connectionPorts({ registry, admit }, "telegram");
    const connection = await registry.connect("telegram");
    await registry.importCredential(connection.id, "bot", {
      material: { token: "t" },
      expiresAt: "never",
    });

    // Pairing answers a pairing code before the inbox hears the channel.
    deliver?.({
      channel: "telegram",
      direction: "inbound",
      messageId: "code",
      conversationId: "dm" as ConversationId,
      senderId: "stranger",
      text: "PAIR-123",
      attachments: [],
      timestamp: new Date(0),
    });
    await rs.waitFor(() => expect(admit).toHaveBeenCalledTimes(1));
  });
});
