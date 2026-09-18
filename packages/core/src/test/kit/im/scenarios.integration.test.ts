import { describe, expect, it } from "@rstest/core";
import type { ConversationId, InboundMessage } from "@rome-os/app-runtime";
import { createTestDb } from "../../helpers.js";
import { ConnectionRegistry } from "../../../connections/registry.js";
import { DrizzleGrantLedger } from "../../../connections/ledger-db.js";
import { makeDiscordDescriptor } from "../../../connections/integrations/discord.js";
import { createFeishuDescriptor } from "../../../connections/integrations/feishu.js";
import { makeTelegramDescriptor } from "../../../connections/integrations/telegram.js";
import { createTalkRouter } from "../../../connections/talk-router.js";
import { SettingsRepository } from "../../../db/repositories/settings.js";
import { ReplyDeliveryRepository } from "../../../db/repositories/reply-delivery.js";
import { PersonMappingRepository } from "../../../db/repositories/person-mapping.js";
import { ApprovalsRepository } from "../../../db/repositories/approvals.js";
import { ConversationSettingsRepository } from "../../../conversation-settings/repository.js";
import { ConversationSettingsService } from "../../../conversation-settings/service.js";
import { createPairingAdmission } from "../../../channels/pairing.js";
import { approvals, replyDeliveryParts } from "../../../db/schema.js";
import { DiscordApiFixture, DISCORD_DM, DISCORD_TOKEN } from "./discord.js";
import { LarkApiFixture } from "./lark.js";
import { TelegramApiFixture, TELEGRAM_TOKEN } from "./telegram.js";
import { deferred, requestBarrier } from "./server.js";
import { sql } from "drizzle-orm";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function discordStack() {
  const fixture = await new DiscordApiFixture().start();
  const test = createTestDb();
  const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(test.db) });
  const conversationSettings = new ConversationSettingsService({
    repository: new ConversationSettingsRepository(test.db),
    connections: registry,
    listAgents: () => [],
  });
  registry.register(
    makeDiscordDescriptor({
      conversationSettings,
      personMappingRepo: new PersonMappingRepository(test.db),
      listAgents: () => [],
      transport: fixture.transport(),
    }),
  );
  const connection = await registry.connect("discord");
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
  await registry.importCredential(connection.id, "bot", {
    material: { token: DISCORD_TOKEN },
    expiresAt: "never",
  });
  await fixture.server.waitForCall(
    (call) => call.method === "PUT" && call.path.endsWith("/commands") && !!call.completedAt,
  );
  return {
    fixture,
    test,
    registry,
    connection,
    router,
    settings,
    async close() {
      await registry.stopAll();
      await fixture.close();
      test.close();
    },
  };
}

describe("IM delivery through production wiring and local API peers", () => {
  it("revokes a queued ordinary send without dispatching it to Discord", async () => {
    const stack = await discordStack();
    const barrier = requestBarrier();
    try {
      const { fixture, router, connection } = stack;
      const path = `/api/v10/channels/${DISCORD_DM}/messages`;
      fixture.server.once({ method: "POST", path, before: barrier.wait });
      const first = router
        .send(connection.id, DISCORD_DM as ConversationId, { text: "in flight" })
        .catch((error) => error);
      await barrier.entered;
      const rejected = expect(
        router.send(connection.id, DISCORD_DM as ConversationId, { text: "revoked" }),
      ).rejects.toThrow();
      await connection.auth.revoke("bot");
      barrier.release();
      await first;
      await rejected;
      expect(
        fixture.server.calls.filter((call) => call.method === "POST" && call.path === path),
      ).toHaveLength(1);
      fixture.server.assertClean();
    } finally {
      barrier.release();
      await stack.close();
    }
  });

  it("paces ordinary splits and multipart attachments and resolves only after the last operation", async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), "rome-im-"));
    const file = join(directory.path, "fixture.txt");
    await writeFile(file, "attachment");
    const stack = await discordStack();
    const barrier = requestBarrier();
    try {
      const { fixture, router, connection, settings } = stack;
      await settings.set(`connection_delivery:${connection.id}`, {
        operationSpacingMs: 20,
        createSpacingMs: 20,
        conversationSpacingMs: 20,
      });
      const path = `/api/v10/channels/${DISCORD_DM}/messages`;
      fixture.server.once({ method: "POST", path, before: barrier.wait });
      let completed = false;
      const sending = router
        .send(connection.id, DISCORD_DM as ConversationId, {
          text: "x".repeat(2001),
          attachments: [{ type: "document", source: file }],
        })
        .then((receipt) => {
          completed = true;
          return receipt;
        });
      await barrier.entered;
      expect(completed).toBe(false);
      barrier.release();
      const receipt = await sending;
      expect(receipt.parts).toHaveLength(3);
      const physical = fixture.server.calls.filter(
        (call) => call.method === "POST" && call.path === path,
      );
      expect(physical).toHaveLength(3);
      expect(physical[1].startedAt - physical[0].startedAt).toBeGreaterThanOrEqual(18);
      expect(physical[2].startedAt - physical[1].startedAt).toBeGreaterThanOrEqual(18);
      expect(physical[2].files).toEqual([
        expect.objectContaining({ name: "fixture.txt", size: 10 }),
      ]);
      fixture.server.assertClean();
    } finally {
      barrier.release();
      await stack.close();
    }
  });

  it("retains an accepted first part when the next physical send is refused", async () => {
    const stack = await discordStack();
    const barrier = requestBarrier();
    try {
      const { fixture, router, connection } = stack;
      const path = `/api/v10/channels/${DISCORD_DM}/messages`;
      fixture.server.once({ method: "POST", path, before: barrier.wait });
      const sending = router.send(connection.id, DISCORD_DM as ConversationId, {
        text: "x".repeat(2001),
      });
      const rejected = expect(sending).rejects.toMatchObject({
        receipts: [
          expect.objectContaining({
            parts: [expect.objectContaining({ messageId: expect.any(String) })],
          }),
        ],
      });
      await barrier.entered;
      fixture.server.once({
        method: "POST",
        path,
        response: { status: 403, body: { code: 50013, message: "Missing Permissions" } },
      });
      barrier.release();
      await rejected;
      expect(fixture.messages.size).toBe(1);
      fixture.server.assertClean();
    } finally {
      barrier.release();
      await stack.close();
    }
  });

  it("does not resend accepted messages when SQLite rejects receipt recording", async () => {
    const stack = await discordStack();
    try {
      const { fixture, router, connection, test } = stack;
      await test.db.run(
        sql`CREATE TRIGGER fail_receipt BEFORE INSERT ON reply_delivery_parts WHEN NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END`,
      );
      const run = (await router.createRunDelivery(connection.id, "recording-failure", {
        conversationId: DISCORD_DM as ConversationId,
      }))!;
      expect(await run.finish("final")).toHaveLength(1);
      expect(fixture.messages.size).toBe(1);
      expect(
        fixture.server.calls.filter(
          (call) => call.method === "POST" && call.path.endsWith("/messages"),
        ),
      ).toHaveLength(1);
      fixture.server.assertClean();
    } finally {
      await stack.close();
    }
  });

  it("blocks a conflicting final edit after an accepted edit loses its response", async () => {
    const stack = await discordStack();
    try {
      const { fixture, router, connection } = stack;
      const run = (await router.createRunDelivery(connection.id, "unknown-edit", {
        conversationId: DISCORD_DM as ConversationId,
      }))!;
      run.append("a");
      await fixture.server.waitForCall(
        (call) =>
          !!call.completedAt &&
          call.method === "POST" &&
          (call.body as { content?: string }).content === "a",
      );
      const id = [...fixture.messages.keys()][0];
      fixture.server.once({
        method: "PATCH",
        path: `/api/v10/channels/${DISCORD_DM}/messages/${id}`,
        dropAfterAccept: true,
      });
      run.append("b");
      await fixture.server.waitForCall((call) => !!call.completedAt && call.method === "PATCH");
      await expect(run.finish("changed")).rejects.toMatchObject({ kind: "unknown" });
      expect(fixture.messages.get(id)?.content).toBe("ab");
      expect(fixture.server.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
      fixture.server.assertClean();
    } finally {
      await stack.close();
    }
  });

  it("progressively edits every overflow part, then streams later commentary and final without duplication", async () => {
    const stack = await discordStack();
    const { fixture, router, connection, test } = stack;
    try {
      const run = (await router.createRunDelivery(connection.id, "fixture-run", {
        conversationId: DISCORD_DM as ConversationId,
      }))!;
      const source = "abcdefghijklmnopqrstuvwx";
      for (let index = 0; index < source.length; index++) {
        run.append(source[index]);
        const tail = source.slice(Math.floor(index / 8) * 8, index + 1);
        await fixture.server.waitForCall(
          (call) => !!call.completedAt && (call.body as { content?: string }).content === tail,
        );
      }
      run.complete(source, "commentary");
      run.append("Later");
      await fixture.server.waitForCall(
        (call) => !!call.completedAt && (call.body as { content?: string }).content === "Later",
      );
      run.complete("Later", "commentary");
      run.append("End");
      await fixture.server.waitForCall(
        (call) => !!call.completedAt && (call.body as { content?: string }).content === "End",
      );
      run.complete("End", "final");
      const receipts = await run.finish("End");
      expect(receipts).toHaveLength(5);
      expect([...fixture.messages.values()].map((message) => message.content)).toEqual([
        "abcdefgh",
        "ijklmnop",
        "qrstuvwx",
        "Later",
        "End",
      ]);
      for (const receipt of receipts.slice(0, 3)) {
        expect(
          fixture.server.calls.filter(
            (call) => call.method === "PATCH" && call.path.endsWith(`/${receipt.messageId}`),
          ).length,
        ).toBeGreaterThan(1);
      }
      const evidence = await test.db.select().from(replyDeliveryParts);
      expect(evidence).toHaveLength(5);
      expect(
        evidence.every((part) => part.outcome === "accepted" && part.operation === "settle"),
      ).toBe(true);
      fixture.server.assertClean();
    } finally {
      await stack.close();
    }
  });

  it("stops queued previews during a delayed create and records the accepted in-flight receipt", async () => {
    const stack = await discordStack();
    const barrier = requestBarrier();
    try {
      const { fixture, router, connection, test } = stack;
      const run = (await router.createRunDelivery(connection.id, "stopped-run", {
        conversationId: DISCORD_DM as ConversationId,
      }))!;
      fixture.server.once({
        method: "POST",
        path: `/api/v10/channels/${DISCORD_DM}/messages`,
        before: barrier.wait,
      });
      run.append("one");
      await barrier.entered;
      run.append(" more pending text");
      const stopped = run.stop();
      barrier.release();
      await stopped;
      expect(fixture.messages.size).toBe(1);
      expect(fixture.server.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
      const evidence = await test.db.select().from(replyDeliveryParts);
      expect(evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            receipt: expect.objectContaining({ messageId: expect.any(String) }),
          }),
        ]),
      );
      fixture.server.assertClean();
    } finally {
      barrier.release();
      await stack.close();
    }
  });

  it.each([
    "telegram",
    "feishu",
  ] as const)("%s raw input reaches Talk only after pairing approval", async (service) => {
    const test = createTestDb();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(test.db) });
    const Fixture = { telegram: TelegramApiFixture, feishu: LarkApiFixture }[service];
    const fixture = new Fixture();
    await fixture.start();
    const credentialSlot = { telegram: "bot", feishu: "app" }[service];
    const people = new PersonMappingRepository(test.db);
    const guardianId = await people.create({
      displayName: "Fixture guardian",
      bondLevel: "guardian",
      approved: true,
    });
    const approvalRepo = new ApprovalsRepository(test.db, () => Buffer.alloc(32, 7));
    const settings = new SettingsRepository(test.db);
    const conversationSettings = new ConversationSettingsService({
      repository: new ConversationSettingsRepository(test.db),
      connections: registry,
      listAgents: () => [],
    });
    registry.register(
      fixture instanceof TelegramApiFixture
        ? makeTelegramDescriptor({ createBot: fixture.createBot })
        : createFeishuDescriptor({
            conversationSettings,
            personMappingRepo: people,
            listAgents: () => [],
            createChannel: (config) => fixture.createChannel(config),
          }),
    );
    const router = createTalkRouter(
      registry,
      createPairingAdmission({
        approvalsRepo: approvalRepo,
        personMappingRepo: people,
        talkGrants: () => [credentialSlot],
      }),
      settings,
      new ReplyDeliveryRepository(test.db),
    );
    try {
      const connection = await registry.connect(service);
      await settings.set(`connection_delivery:${connection.id}`, {
        operationSpacingMs: 0,
        createSpacingMs: 0,
        conversationSpacingMs: 0,
      });
      await registry.importCredential(connection.id, credentialSlot, {
        material:
          fixture instanceof TelegramApiFixture
            ? { token: TELEGRAM_TOKEN }
            : { appId: fixture.appId, appSecret: fixture.appSecret },
        expiresAt: "never",
      });
      if (fixture instanceof TelegramApiFixture) await fixture.untilPolling();
      else await fixture.untilConnected();
      const delivered: InboundMessage[] = [];
      const accepted = deferred();
      router.subscribe(connection.id, async (message) => {
        delivered.push(message);
        accepted.resolve();
      });
      await fixture.emitMessage("stranger candidate");
      await fixture.server.waitForCall(
        (call) =>
          !!call.completedAt &&
          (call.path.endsWith("/sendMessage") || call.path.endsWith("/im/v1/messages")),
      );
      expect(delivered).toHaveLength(0);
      const pending = await test.db.select().from(approvals);
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe("pending");
      const resolution = await approvalRepo.resolvePending(pending[0].id, "approve", guardianId);
      expect(resolution).toBeTruthy();
      await fixture.emitMessage("paired input");
      await accepted.promise;
      expect(delivered.map((message) => message.text)).toEqual(["paired input"]);
      fixture.server.assertClean();
    } finally {
      await registry.stopAll();
      await fixture.close();
      test.close();
    }
  });
});
