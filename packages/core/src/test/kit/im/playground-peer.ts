import { randomUUID } from "node:crypto";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@rome-os/app-runtime";
import { createTestDb } from "../../helpers.js";
import { ConnectionRegistry } from "../../../connections/registry.js";
import { DrizzleGrantLedger } from "../../../connections/ledger-db.js";
import { createTalkRouter } from "../../../connections/talk-router.js";
import { makeDiscordDescriptor } from "../../../connections/integrations/discord.js";
import { makeTelegramDescriptor } from "../../../connections/integrations/telegram.js";
import { createFeishuDescriptor } from "../../../connections/integrations/feishu.js";
import { createWechatDescriptor } from "../../../connections/integrations/wechat.js";
import { ConversationSettingsRepository } from "../../../conversation-settings/repository.js";
import { ConversationSettingsService } from "../../../conversation-settings/service.js";
import { PersonMappingRepository } from "../../../db/repositories/person-mapping.js";
import { SettingsRepository } from "../../../db/repositories/settings.js";
import { ReplyDeliveryRepository } from "../../../db/repositories/reply-delivery.js";
import { WebChatRepository } from "../../../db/repositories/webchat.js";
import { replyDeliveryParts } from "../../../db/schema.js";
import { WechatAdapter } from "../../../channels/wechat.js";
import type { RunDelivery } from "../../../connections/delivery/run-delivery.js";
import { DiscordApiFixture, DISCORD_DM, DISCORD_TOKEN, DISCORD_USER } from "./discord.js";
import { TelegramApiFixture, TELEGRAM_TOKEN } from "./telegram.js";
import { LarkApiFixture, LARK_CHAT } from "./lark.js";
import { WechatApiFixture, WECHAT_ORIGIN, WECHAT_USER } from "./wechat.js";
import { deferred } from "./server.js";

interface PlaygroundConfig {
  platform: "discord" | "telegram" | "feishu" | "wechat";
  mode: "edit" | "blocks" | "final";
  chunkSize: number;
  intervalMs: number;
}

export type PlaygroundPeer = Awaited<ReturnType<typeof createPlaygroundPeer>>;

export async function createPlaygroundPeer(
  config: PlaygroundConfig,
  receive: (text: string) => void,
) {
  const { platform } = config;
  const Fixture = {
    discord: DiscordApiFixture,
    telegram: TelegramApiFixture,
    feishu: LarkApiFixture,
    wechat: WechatApiFixture,
  }[platform];
  const fixture = new Fixture();
  await fixture.start();
  const directory = await mkdtempDisposable(join(tmpdir(), "rome-im-playground-"));
  const test = createTestDb();
  const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(test.db) });
  const settings = new SettingsRepository(test.db);
  const conversations = new WebChatRepository(test.db);
  const conversationSettings = new ConversationSettingsService({
    repository: new ConversationSettingsRepository(test.db),
    connections: registry,
    listAgents: () => [],
  });
  const deps = {
    conversationSettings,
    personMappingRepo: new PersonMappingRepository(test.db),
    listAgents: () => [],
  };
  const descriptor = (() => {
    if (fixture instanceof DiscordApiFixture)
      return makeDiscordDescriptor({ ...deps, transport: fixture.transport() });
    if (fixture instanceof TelegramApiFixture)
      return makeTelegramDescriptor({ createBot: fixture.createBot });
    if (fixture instanceof LarkApiFixture)
      return createFeishuDescriptor({
        ...deps,
        createChannel: (input) => fixture.createChannel(input),
      });
    return createWechatDescriptor({
      createAdapter: (input) =>
        new WechatAdapter({ ...input, statePath: directory.path }, fixture.fetch),
    });
  })();
  registry.register(descriptor);
  let run: RunDelivery | null = null;
  let detach = () => {};
  const close = async () => {
    await run?.stop();
    detach();
    try {
      await registry.stopAll();
    } finally {
      await fixture.close();
      test.close();
      await directory[Symbol.asyncDispose]();
    }
  };
  try {
    const connection = await registry.connect(platform);
    await settings.set(`connection_delivery:${connection.id}`, {
      mode: config.mode,
      maxPartSize: config.chunkSize,
      coalesceMs: config.intervalMs,
    });
    const router = createTalkRouter(
      registry,
      undefined,
      settings,
      new ReplyDeliveryRepository(test.db),
    );
    const conversationId = {
      discord: DISCORD_DM,
      telegram: "123",
      feishu: LARK_CHAT,
      wechat: WECHAT_USER,
    }[platform] as ConversationId;
    const conversation = await conversations.ensureChannelConversation({
      channel: platform,
      threadId: conversationId,
      agentName: "main",
    });
    let received = deferred();
    detach = router.subscribe(connection.id, async (message) => {
      await conversations.addConversationMessage({
        sessionId: conversation.id,
        role: "user",
        content: JSON.stringify([{ type: "text", content: message.text }]),
        platformMessageId: message.messageId,
        senderId: message.senderId,
      });
      receive(message.text);
      received.resolve();
    });
    const material = ((): Record<string, string> => {
      if (fixture instanceof LarkApiFixture)
        return { appId: fixture.appId, appSecret: fixture.appSecret };
      if (fixture instanceof WechatApiFixture)
        return { token: "fixture-token", baseUrl: WECHAT_ORIGIN, accountId: "fixture-bot" };
      return {
        token: { discord: DISCORD_TOKEN, telegram: TELEGRAM_TOKEN }[
          platform as "discord" | "telegram"
        ],
      };
    })();
    await registry.importCredential(
      connection.id,
      { discord: "bot", telegram: "bot", feishu: "app", wechat: "account" }[platform],
      { material, expiresAt: "never" },
    );
    if (fixture instanceof DiscordApiFixture)
      await fixture.server.waitForCall(
        (call) => call.path.endsWith("/commands") && !!call.completedAt,
      );
    else if (fixture instanceof LarkApiFixture) await fixture.untilConnected();
    else await fixture.untilPolling();
    if (fixture instanceof DiscordApiFixture)
      await router.feature(connection.id, "directMessaging")?.conversationFor(DISCORD_USER);
    return {
      server: fixture.server,
      close,
      receipts: () => test.db.select().from(replyDeliveryParts).all(),
      async send(text: string) {
        return router.send(connection.id, conversationId, { text });
      },
      async startRun() {
        run = await router.createRunDelivery(connection.id, randomUUID(), { conversationId });
        if (!run) throw new Error("Text delivery is unavailable");
        return run;
      },
      async finishRun(text: string) {
        if (!run) throw new Error("No active run");
        const receipts = await run.finish(text);
        await conversations.recordOutboundConversationMessage({
          sessionId: conversation.id,
          content: JSON.stringify([{ type: "text", content: text }]),
          platformMessageId: receipts.at(-1)?.messageId,
          turnId: run.runId,
          senderId: "rome",
          senderName: "Rome",
          knownToProvider: true,
        });
      },
      async stop() {
        await run?.stop();
      },
      async inbound(text: string) {
        received = deferred();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.all([
            fixture.emitMessage(text),
            Promise.race([
              received.promise,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Inbound delivery timed out")), 5000);
              }),
            ]),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
      mutation: () => ({
        method: "POST",
        path: {
          discord: `/api/v10/channels/${DISCORD_DM}/messages`,
          telegram: `/bot${TELEGRAM_TOKEN}/sendMessage`,
          feishu: "/open-apis/im/v1/messages",
          wechat: "/ilink/bot/sendmessage",
        }[platform],
      }),
      messages() {
        if (fixture instanceof WechatApiFixture)
          return fixture.messages.map((message, index) => ({
            id: String(index + 1),
            text: (message.item_list as { text_item?: { text: string } }[])
              .map((item) => item.text_item?.text ?? "")
              .join(""),
            edited: false,
          }));
        if (fixture instanceof LarkApiFixture)
          return [...fixture.messages.values()]
            .filter((message) => message.sender?.sender_type === "app")
            .map((message) => ({
              id: message.message_id,
              text: JSON.parse(message.body.content).text ?? message.body.content,
              edited: message.updated,
            }));
        if (fixture instanceof DiscordApiFixture)
          return [...fixture.messages.values()]
            .filter((message) => message.author.bot)
            .map((message) => ({
              id: message.id,
              text: message.content,
              edited: !!message.edited_timestamp,
            }));
        return [...fixture.messages.values()].map((message) => ({
          id: String(message.message_id),
          text: String(message.text ?? ""),
          edited: !!message.edit_date,
        }));
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
