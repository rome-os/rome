import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import type * as connections from "../../connections/message.js";
import { legacyMessage } from "../../connections/test-fixtures.js";
import { createTestDb, kindChannelOf, type TestDb } from "../../test/db.js";
import { DrizzleConnectionsRepository } from "../../connections/repository-db.js";
import { ConnectionRegistry } from "../../connections/registry.js";
import { tokenPaste } from "../../connections/schemes.js";
import type { ConnectionDescriptor, Talker } from "../../connections/types.js";
import { AdmissionTimedOut, OrderedAdmission } from "./admission.js";
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
      deliver?: (message: connections.Message) => void;
      sends: string[];
      epoch: number;
    }> = [];
    const descriptor: ConnectionDescriptor = {
      connectionKind: "discord",
      grant: "bot",
      auth: tokenPaste({ label: "token", validate: async () => {} }),
      capabilities: {
        talker: {
          build(): Talker {
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
              async send(chatId, message) {
                state.sends.push(message.text ?? "");
                return { chatId, messageId: `sent-${state.epoch}` };
              },
            };
          },
        },
      },
    };
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
    });
    registry.register(descriptor);
    const connection = await registry.connect("discord");
    const admit = rs.fn(
      async (_id: string, _service: string, message: ChannelMessage) =>
        message.senderId === "guardian",
    );
    const ports = connectionPorts(
      { registry, channelOf: kindChannelOf, ...(gated ? { admit } : {}) },
      "discord",
    )!;
    const sibling: string[] = [];
    const unsubscribe = ports.inbound!.subscribe(async (event) => {
      sibling.push(event.message.messageId);
    });
    const received: string[] = [];
    ports.inbound!.subscribe(async (event) => {
      received.push(event.message.messageId);
    });

    await registry.giveGrant(connection.connectionKind, connection.id, "bot", {
      material: { token: "first" },
      expiresAt: "never",
    });
    instances[0]!.deliver?.(
      legacyMessage({
        messageId: "inbound-1",
        chatId: "general" as ChatId,
        senderId: "guardian",
        text: "hello",
        attachments: [],
        timestamp: new Date(0),
      }),
    );
    await rs.waitFor(() => expect(received).toEqual(["inbound-1"]));
    await rs.waitFor(() => expect(sibling).toEqual(["inbound-1"]));
    // Admission runs once per message, however many subscribe.
    if (gated) expect(admit).toHaveBeenCalledTimes(1);

    await expect(
      ports.send!.send("general" as ChatId, { text: "first reply" }),
    ).resolves.toMatchObject({ messageId: "sent-1" });

    // Past its epoch nothing reaches the stopped talker.
    await connection.auth.revoke("bot");
    expect(connection.withTalker(() => "reached")).toBeUndefined();
    expect(connection.isUnlocked("chat")).toBe(false);
    await registry.giveGrant(connection.connectionKind, connection.id, "bot", {
      material: { token: "second" },
      expiresAt: "never",
    });
    instances[1]!.deliver?.(
      legacyMessage({
        messageId: "inbound-2",
        chatId: "general" as ChatId,
        senderId: "guardian",
        text: "hello again",
        attachments: [],
        timestamp: new Date(0),
      }),
    );
    await rs.waitFor(() => expect(received).toEqual(["inbound-1", "inbound-2"]));
    await rs.waitFor(() => expect(sibling).toEqual(received));
    if (gated) {
      expect(admit).toHaveBeenCalledTimes(2);
      instances[1]!.deliver?.(
        legacyMessage({
          messageId: "blocked",
          chatId: "general" as ChatId,
          senderId: "unknown",
          text: "not authorized",
          attachments: [],
          timestamp: new Date(),
        }),
      );
      await rs.waitFor(() => expect(admit).toHaveBeenCalledTimes(3));
      expect(received).toEqual(["inbound-1", "inbound-2"]);
    }
    unsubscribe();
    await expect(
      ports.send!.send("general" as ChatId, { text: "second reply" }),
    ).resolves.toMatchObject({ messageId: "sent-2" });
  });

  it("admits a message even before anyone subscribes", async () => {
    testDb = createTestDb();
    let deliver: ((message: connections.Message) => void) | undefined;
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
    });
    registry.register({
      connectionKind: "telegram",
      grant: "bot",
      auth: tokenPaste({ label: "token", validate: async () => {} }),
      capabilities: {
        talker: {
          build: (): Talker => ({
            start(next) {
              deliver = next;
            },
            stop() {},
            send: async (chatId) => ({ chatId }),
          }),
        },
      },
    });
    const admit = rs.fn(async () => false);
    connectionPorts({ registry, admit, channelOf: kindChannelOf }, "telegram");
    const connection = await registry.connect("telegram");
    await registry.giveGrant(connection.connectionKind, connection.id, "bot", {
      material: { token: "t" },
      expiresAt: "never",
    });

    // Admission runs before the inbox hears the channel.
    deliver?.(
      legacyMessage({
        messageId: "code",
        chatId: "dm" as ChatId,
        senderId: "stranger",
        text: "hello",
        attachments: [],
        timestamp: new Date(0),
      }),
    );
    await rs.waitFor(() => expect(admit).toHaveBeenCalledTimes(1));
  });
});

describe("OrderedAdmission", () => {
  const inbound = (messageId: string) => ({ messageId, chatId: "c" }) as ChannelMessage;
  const connection = { id: "conn-1", connectionKind: "telegram" };

  it("rejects a delivery whose admission runs past its time, so it is not taken as accepted, and admits the next", async () => {
    const admission = new OrderedAdmission(
      (_id, _kind, message) =>
        message.messageId === "stuck" ? new Promise<boolean>(() => {}) : Promise.resolve(true),
      { admissionTimeoutMs: 20 },
    );
    const heard: string[] = [];
    const hear = async (message: ChannelMessage) => {
      heard.push(message.messageId);
    };
    const stuck = admission.deliver(connection, inbound("stuck"), hear);
    const next = admission.deliver(connection, inbound("next"), hear);
    await expect(stuck).rejects.toBeInstanceOf(AdmissionTimedOut);
    await expect(next).resolves.toBeUndefined();
    expect(heard).toEqual(["next"]);
  });

  it("resolves a delivery admission refuses, which Rome leaves out", async () => {
    const admission = new OrderedAdmission(async () => false);
    const heard: string[] = [];
    await expect(
      admission.deliver(connection, inbound("refused"), async (message) => {
        heard.push(message.messageId);
      }),
    ).resolves.toBeUndefined();
    expect(heard).toEqual([]);
  });
});
