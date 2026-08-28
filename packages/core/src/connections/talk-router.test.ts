import { afterEach, describe, expect, it } from "@rstest/core";
import type {
  ConversationId,
  InboundMessage,
  TalkFeatureMap,
  TalkFeatureName,
} from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { ConnectionRegistry } from "./registry.js";
import { tokenPaste } from "./schemes.js";
import type { ConnectionDescriptor, Talker } from "./types.js";
import { createTalkRouter } from "./talk-router.js";

describe("ConnectionTalkRouter", () => {
  let testDb: TestDb | undefined;
  afterEach(() => testDb?.close());

  it("keeps subscriptions and semantic feature handles on the current epoch", async () => {
    testDb = createTestDb();
    const instances: Array<{
      deliver?: (message: InboundMessage) => void;
      sends: string[];
      epoch: number;
    }> = [];
    const descriptor: ConnectionDescriptor = {
      service: "discord",
      auth: {
        bot: tokenPaste({ label: "token", validate: async () => {} }),
      },
      capabilities: {
        talker: {
          needs: ["bot"],
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
              async send(conversationId, message) {
                state.sends.push(message.text ?? "");
                return { conversationId, messageId: `sent-${state.epoch}` };
              },
              feature<K extends TalkFeatureName>(name: K): TalkFeatureMap[K] | null {
                if (name !== "history") return null;
                return {
                  query: async () => [
                    {
                      messageId: `history-${state.epoch}`,
                      conversationId: "general" as ConversationId,
                      senderId: "guardian",
                      text: `epoch ${state.epoch}`,
                      attachments: [],
                      timestamp: new Date(0),
                    },
                  ],
                } as unknown as TalkFeatureMap[K];
              },
            };
          },
        },
      },
    };
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(testDb.db) });
    registry.register(descriptor);
    const connection = await registry.connect("discord");
    const router = createTalkRouter(registry);
    const received: string[] = [];
    router.subscribe(connection.id, async (message) => {
      received.push(message.messageId);
    });

    await registry.importCredential(connection.id, "bot", {
      material: { token: "first" },
      expiresAt: "never",
    });
    instances[0]!.deliver?.({
      messageId: "inbound-1",
      conversationId: "general" as ConversationId,
      senderId: "guardian",
      text: "hello",
      attachments: [],
      timestamp: new Date(0),
    });
    expect(received).toEqual(["inbound-1"]);
    expect(await router.list()).toEqual([{ connectionId: connection.id, service: "discord" }]);

    const history = router.feature(connection.id, "history");
    expect((await history?.query({ limit: 10 }))?.[0]?.messageId).toBe("history-1");
    await expect(
      router.send(connection.id, "general" as ConversationId, { text: "first reply" }),
    ).resolves.toMatchObject({ messageId: "sent-1" });

    await connection.auth.revoke("bot");
    expect(() => history?.query({ limit: 10 })).toThrow("Talk is unavailable");
    await registry.importCredential(connection.id, "bot", {
      material: { token: "second" },
      expiresAt: "never",
    });
    instances[1]!.deliver?.({
      messageId: "inbound-2",
      conversationId: "general" as ConversationId,
      senderId: "guardian",
      text: "hello again",
      attachments: [],
      timestamp: new Date(0),
    });
    expect(received).toEqual(["inbound-1", "inbound-2"]);
    expect((await history?.query({ limit: 10 }))?.[0]?.messageId).toBe("history-2");
  });
});
