import { describe, expect, it } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import { createTestDb } from "../../test/helpers.js";
import { FakeTelegramApi } from "../../test/kit/fake-telegram.js";
import { ReplyDeliveryRepository } from "../../db/repositories/reply-delivery.js";
import { SettingsRepository } from "../../db/repositories/settings.js";
import { replyDeliveryParts } from "../../db/schema.js";
import { ConnectionRegistry } from "../registry.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { createTalkRouter } from "../talk-router.js";
import { makeTelegramDescriptor } from "../integrations/telegram.js";

describe("Telegram run delivery through Talk", () => {
  it("classifies interrupted attempts as unknown without changing accepted receipts", async () => {
    const test = createTestDb();
    try {
      const repository = new ReplyDeliveryRepository(test.db);
      const attempt = {
        runId: "interrupted-run",
        blockIx: 0,
        partIx: 0,
        sourceStart: 0,
        sourceEnd: 5,
        revision: 1,
        target: { conversationId: "123" as ConversationId },
        operation: "create" as const,
      };
      await repository.record({ ...attempt, outcome: "attempting" });
      await repository.record({
        ...attempt,
        partIx: 1,
        outcome: "accepted",
        receipt: { conversationId: "123" as ConversationId, messageId: "known-id" },
      });
      await repository.recoverInterrupted();
      const rows = await test.db.select().from(replyDeliveryParts);
      expect(rows.find((row) => row.partIx === 0)?.outcome).toBe("unknown");
      expect(rows.find((row) => row.partIx === 1)).toMatchObject({
        outcome: "accepted",
        receipt: { messageId: "known-id" },
      });
    } finally {
      test.close();
    }
  });

  it("paces ordinary splits and attachments, awaits each send, and rejects a revoked queued send", async () => {
    const test = createTestDb();
    const fake = new FakeTelegramApi();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(test.db) });
    const times: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.register(
      makeTelegramDescriptor({
        createBot: (token) => {
          const bot = fake.createBot(token);
          bot.api.config.use(async (previous, method, payload, signal) => {
            if (method === "sendMessage" || method === "sendDocument") times.push(Date.now());
            if (method === "sendDocument") await gate;
            return previous(method, payload, signal);
          });
          return bot;
        },
      }),
    );
    try {
      const connection = await registry.connect("telegram");
      await registry.importCredential(connection.id, "bot", {
        material: { token: "test-token" },
        expiresAt: "never",
      });
      await fake.untilPolling();
      const settings = new SettingsRepository(test.db);
      await settings.set(`connection_delivery:${connection.id}`, {
        operationSpacingMs: 20,
        createSpacingMs: 20,
        conversationSpacingMs: 20,
      });
      const router = createTalkRouter(
        registry,
        undefined,
        settings,
        new ReplyDeliveryRepository(test.db),
      );
      let completed = false;
      const send = router
        .send(connection.id, "123" as ConversationId, {
          text: "a".repeat(4001),
          attachments: [{ type: "document", source: "/tmp/delivery-test.txt" }],
        })
        .then((receipt) => {
          completed = true;
          return receipt;
        });
      for (let i = 0; i < 200 && times.length < 3; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(times).toHaveLength(3);
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(18);
      expect(times[2] - times[1]).toBeGreaterThanOrEqual(18);
      expect(completed).toBe(false);
      const queued = router.send(connection.id, "123" as ConversationId, { text: "must not send" });
      const rejected = expect(queued).rejects.toThrow();
      await connection.auth.revoke("bot");
      release();
      expect((await send).parts).toHaveLength(3);
      await rejected;
      expect(fake.sent).toHaveLength(3);
    } finally {
      release();
      await registry.stopAll();
      test.close();
    }
  });
  it("updates three physical messages through the real SDK seam and records settlement", async () => {
    const test = createTestDb();
    const fake = new FakeTelegramApi();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(test.db) });
    registry.register(makeTelegramDescriptor({ createBot: fake.createBot }));
    try {
      const connection = await registry.connect("telegram");
      await registry.importCredential(connection.id, "bot", {
        material: { token: "test-token" },
        expiresAt: "never",
      });
      await fake.untilPolling();
      const settings = new SettingsRepository(test.db);
      await settings.set(`connection_delivery:${connection.id}`, {
        maxPartSize: 8,
        operationSpacingMs: 0,
        createSpacingMs: 0,
        updateSpacingMs: 0,
        conversationSpacingMs: 0,
      });
      const router = createTalkRouter(
        registry,
        undefined,
        settings,
        new ReplyDeliveryRepository(test.db),
      );
      const run = await router.createRunDelivery(connection.id, "run", {
        conversationId: "123" as ConversationId,
        replyToMessageId: "99",
      });
      expect(run).not.toBeNull();
      const source = "abcdefghijklmnopqrstuvwx";
      for (const character of source) {
        run!.append(character);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      run!.complete(source, "final");
      const receipts = await run!.finish(source);
      expect(receipts).toHaveLength(3);
      const creates = fake.sent.filter((call) => call.method === "sendMessage");
      expect(creates).toHaveLength(3);
      for (const receipt of receipts) {
        const edits = fake.sent.filter(
          (call) =>
            call.method === "editMessageText" &&
            String(call.payload.message_id) === receipt.messageId,
        );
        expect(edits.length).toBeGreaterThan(1);
        expect(receipt.conversationId).toBe("123");
      }
      expect(
        creates.every(
          (call) => (call.payload.reply_parameters as { message_id: number }).message_id === 99,
        ),
      ).toBe(true);
      const rows = await test.db.select().from(replyDeliveryParts);
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.operation === "settle" && row.outcome === "accepted")).toBe(
        true,
      );
    } finally {
      await registry.stopAll();
      test.close();
    }
  });
});
