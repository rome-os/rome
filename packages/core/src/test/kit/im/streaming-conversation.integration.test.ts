import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WechatAdapter } from "../../../channels/wechat.js";
import { createWechatDescriptor } from "../../../connections/integrations/wechat.js";
import { WechatApiFixture, WECHAT_ORIGIN, WECHAT_USER } from "./wechat.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import { createTestRome } from "../test-rome.js";
import { ConnectionRegistry } from "../../../connections/registry.js";
import { DrizzleGrantLedger } from "../../../connections/ledger-db.js";
import { makeDiscordDescriptor } from "../../../connections/integrations/discord.js";
import { createTalkRouter } from "../../../connections/talk-router.js";
import { ConversationSettingsRepository } from "../../../conversation-settings/repository.js";
import { ConversationSettingsService } from "../../../conversation-settings/service.js";
import { ReplyDeliveryRepository } from "../../../db/repositories/reply-delivery.js";
import { WebChatRepository } from "../../../db/repositories/webchat.js";
import { replyDeliveryParts, romeAgentMessages } from "../../../db/schema.js";
import { AgentSessionBridge } from "../../../core/agent-session-bridge.js";
import { createAgentTurnStreamRegistry } from "../../../core/agent-turn-stream-registry.js";
import { DiscordApiFixture, DISCORD_DM, DISCORD_TOKEN } from "./discord.js";
import { makeTelegramDescriptor } from "../../../connections/integrations/telegram.js";
import { createFeishuDescriptor } from "../../../connections/integrations/feishu.js";
import { TelegramApiFixture, TELEGRAM_TOKEN } from "./telegram.js";
import { LarkApiFixture, LARK_CHAT } from "./lark.js";
import { deferred } from "./server.js";
import type { ModelUserInput } from "../../../core/agent-runner.js";

class Worker extends EventEmitter {
  connected = true;
  sent: unknown[] = [];
  send(message: unknown) {
    this.sent.push(message);
    return true;
  }
}

const deltas = ["pre", "view", " final", " now", "!"];
const finalText = "preview final now!";
const finalParts = ["preview", " final ", "now!"];
const stages = {
  edit: [["pre"], ["preview"], ["preview", " final"], ["preview", " final ", "now"], finalParts],
  blocks: [[], [], ["preview"], ["preview", " final "], ["preview", " final "]],
  final: [[], [], [], [], []],
};

describe.each([
  { platform: "discord", mode: "edit", unsupportedMode: "blocks", behavior: "edit" },
  { platform: "telegram", mode: "edit", unsupportedMode: "blocks", behavior: "edit" },
  { platform: "feishu", mode: "edit", unsupportedMode: "blocks", behavior: "edit" },
  { platform: "wechat", mode: "blocks", unsupportedMode: "blocks", behavior: "blocks" },
  { platform: "feishu", mode: "blocks", unsupportedMode: "blocks", behavior: "blocks" },
  { platform: "feishu", mode: "final", unsupportedMode: "blocks", behavior: "final" },
  { platform: "wechat", mode: "edit", unsupportedMode: "blocks", behavior: "blocks" },
  { platform: "wechat", mode: "edit", unsupportedMode: "final", behavior: "final" },
] as const)("Agent streaming through IPC: %j", ({ platform, mode, unsupportedMode, behavior }) => {
  it.each([
    "completed",
    "cancelled",
    "failed",
    "steered",
  ] as const)("persists the correct delivery when generation is %s", async (outcome) => {
    await using directory = await mkdtempDisposable(join(tmpdir(), "rome-streaming-"));
    await writeFile(
      join(directory.path, "context_tokens.json"),
      JSON.stringify({ [WECHAT_USER]: "fixture-context" }),
    );
    const rome = await createTestRome();
    const Fixture = {
      discord: DiscordApiFixture,
      telegram: TelegramApiFixture,
      feishu: LarkApiFixture,
      wechat: WechatApiFixture,
    }[platform];
    const fixture = new Fixture();
    await fixture.start();
    const threadId = {
      discord: DISCORD_DM,
      telegram: "123",
      feishu: LARK_CHAT,
      wechat: WECHAT_USER,
    }[platform];
    const incomingId = platform === "telegram" ? "999" : "om_incoming";
    const messages = () => {
      if (fixture instanceof WechatApiFixture) {
        return fixture.messages.map((message) => ({
          id: undefined,
          text: (message.item_list as Array<{ text_item: { text: string } }>)
            .map((item) => item.text_item.text)
            .join(""),
        }));
      }
      return [...fixture.messages.values()]
        .filter(
          (message) => !("message_id" in message) || String(message.message_id) !== incomingId,
        )
        .map((message) => {
          const id = String("id" in message ? message.id : message.message_id);
          if ("body" in message)
            return { id, text: JSON.parse((message.body as { content: string }).content).text };
          if ("text" in message) return { id, text: message.text };
          return { id, text: message.content };
        });
    };
    const isCreate = (call: { method: string; path: string }) =>
      call.method === "POST" &&
      (call.path.endsWith("/messages") ||
        call.path.endsWith("/sendMessage") ||
        call.path.endsWith("/reply") ||
        call.path.endsWith("/sendmessage"));
    const isUpdate = (call: { method: string; path: string }) =>
      call.method === "PATCH" ||
      (call.method === "PUT" && call.path.includes("/messages/")) ||
      call.path.endsWith("/editMessageText");
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(rome.db) });
    const gates = deltas.map(() => deferred());
    const turns = createAgentTurnStreamRegistry();
    const child = new Worker();
    let generationFinished = false;
    const steered: ModelUserInput[] = [];
    let firstInputId: string | undefined;
    const providerRuns: Promise<void>[] = [];
    const openSession = rome.model.openSession.bind(rome.model);
    const sessionModel = rs.spyOn(rome.model, "openSession").mockImplementation(async (params) => {
      const session = await openSession(params);
      if (outcome === "steered") {
        const send = session.sendUserInput.bind(session);
        session.sendUserInput = async (input) => {
          firstInputId = input.inputId;
          providerRuns.push(send(input));
        };
      }
      session.steerUserInput = async (input) => {
        steered.push(input);
        return "accepted";
      };
      return session;
    });
    const model = rs.spyOn(rome.model, "run").mockImplementation(async function* () {
      if (outcome === "steered")
        yield { type: "input_status", inputId: firstInputId!, state: "consumed" };
      for (const [index, content] of deltas.entries()) {
        yield { type: "text_delta", content };
        await gates[index].promise;
        if (index === 0 && outcome === "steered")
          yield { type: "input_status", inputId: steered[0].inputId!, state: "consumed" };
      }
      generationFinished = true;
      if (outcome === "failed") yield { type: "error", error: "fixture generation failed" };
      else {
        yield { type: "text", content: finalText, turnPhase: "final" };
        yield { type: "result", content: finalText };
      }
    });
    try {
      const settings = new ConversationSettingsService({
        repository: new ConversationSettingsRepository(rome.db),
        connections: registry,
        listAgents: () => [],
      });
      const deps = {
        conversationSettings: settings,
        personMappingRepo: rome.repos.personMapping,
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
            createChannel: (config) => fixture.createChannel(config),
          });
        return createWechatDescriptor({
          createAdapter: (config) =>
            new WechatAdapter({ ...config, statePath: directory.path }, fixture.fetch),
        });
      })();
      registry.register(descriptor);
      const connection = await registry.connect(platform);
      await rome.repos.settings.set(`connection_delivery:${connection.id}`, {
        coalesceMs: 0,
        mode,
        unsupportedMode,
        maxPartSize: 7,
        maxPendingAgeMs: 60_000,
        operationSpacingMs: 0,
        createSpacingMs: 0,
        updateSpacingMs: 0,
        conversationSpacingMs: 0,
      });
      const router = createTalkRouter(
        registry,
        undefined,
        rome.repos.settings,
        new ReplyDeliveryRepository(rome.db),
      );
      const credentialSlot = { discord: "bot", telegram: "bot", feishu: "app", wechat: "account" }[
        platform
      ];
      const material = ((): Record<string, string> => {
        if (fixture instanceof LarkApiFixture)
          return { appId: fixture.appId, appSecret: fixture.appSecret };
        if (fixture instanceof WechatApiFixture)
          return { token: "fixture-token", baseUrl: WECHAT_ORIGIN, accountId: "fixture-bot" };
        return { token: platform === "telegram" ? TELEGRAM_TOKEN : DISCORD_TOKEN };
      })();
      await registry.importCredential(connection.id, credentialSlot, {
        material,
        expiresAt: "never",
      });
      if (fixture instanceof DiscordApiFixture) {
        await fixture.server.waitForCall(
          (call) => call.method === "PUT" && call.path.endsWith("/commands") && !!call.completedAt,
        );
      } else if (fixture instanceof TelegramApiFixture) {
        await fixture.untilPolling();
        fixture.messages.set(999, {
          message_id: 999,
          chat: { id: 123, type: "private" },
          text: "question",
          from: { id: 123, is_bot: false, first_name: "Alice" },
          date: 1700000000,
        });
      } else if (fixture instanceof WechatApiFixture) {
        await fixture.untilPolling();
      } else {
        await fixture.untilConnected();
        await fixture.emitMessage("question", "incoming");
      }
      const webchat = new WebChatRepository(rome.db);
      const conversation = await webchat.ensureChannelConversation({
        channel: platform,
        threadId,
        threadType: "private",
        agentName: "main",
      });
      await webchat.addConversationMessage({
        sessionId: conversation.id,
        role: "user",
        content: "[]",
        platformMessageId: incomingId,
      });
      const bridge = new AgentSessionBridge(
        rome.agentSessions,
        webchat,
        undefined,
        turns,
        router,
        rome.repos.approvals,
      );
      bridge.attach(child as unknown as ChildProcess);
      child.emit("message", {
        type: "rpc_request",
        reqId: "stream",
        method: "agent.session.runTurn",
        params: {
          admissionOnly: true,
          key: { agentName: "main", channelThreadKey: `${platform}:${threadId}` },
          input: { prompt: "stream the answer" },
          platformMessageId: incomingId,
          init: {
            romeSessionId: conversation.id,
            threadContext: {
              channel: platform,
              connectionId: connection.id,
              threadId,
              threadType: "private",
              senderBondLevel: "guardian",
            },
          },
        },
      });
      await rs.waitFor(() =>
        expect(
          turns.getActiveByConversation({
            connectionId: connection.id,
            conversationId: threadId as ConversationId,
          }),
        ).toBeDefined(),
      );
      const active = turns.getActiveByConversation({
        connectionId: connection.id,
        conversationId: threadId as ConversationId,
      })!;
      const ids: Array<string | undefined> = [];
      for (const index of deltas.keys()) {
        await rs.waitFor(() =>
          expect(active.messages().filter((message) => message.type === "text_delta")).toHaveLength(
            index + 1,
          ),
        );
        await rs.waitFor(() =>
          expect(messages().map((message) => message.text)).toEqual(stages[behavior][index]),
        );
        expect(generationFinished).toBe(false);
        for (const [part, id] of ids.entries()) expect(messages()[part].id).toBe(id);
        ids.splice(0, ids.length, ...messages().map((message) => message.id));
        if (index === 0 && outcome === "steered") {
          await webchat.addConversationMessage({
            sessionId: conversation.id,
            role: "user",
            content: "[]",
            platformMessageId: "followup",
          });
          for (const reqId of ["followup", "duplicate"]) {
            child.emit("message", {
              type: "rpc_request",
              reqId,
              method: "agent.session.runTurn",
              params: {
                admissionOnly: true,
                key: { agentName: "main", channelThreadKey: `${platform}:${threadId}` },
                input: { prompt: "include the follow-up" },
                platformMessageId: "followup",
                init: {
                  romeSessionId: conversation.id,
                  threadContext: {
                    channel: platform,
                    connectionId: connection.id,
                    threadId,
                    threadType: "private",
                    senderBondLevel: "guardian",
                  },
                },
              },
            });
          }
          await rs.waitFor(() => {
            expect(steered).toHaveLength(1);
            expect(
              child.sent.filter((message) => (message as { type: string }).type === "rpc_response"),
            ).toHaveLength(3);
          });
          expect(steered[0].text).toBe("include the follow-up");
        }
        if (outcome === "cancelled") {
          await active.interrupt!("fixture stop");
          for (const gate of gates) gate.resolve();
          break;
        }
        gates[index].resolve();
      }
      await active.waitForFinish();
      const completed = outcome === "completed" || outcome === "steered";
      const expected = {
        completed: finalParts,
        steered: finalParts,
        cancelled: stages[behavior][0],
        failed: stages[behavior][deltas.length - 1],
      }[outcome];
      expect(messages().map((message) => message.text)).toEqual(expected);
      const attempts = await rome.db.select().from(replyDeliveryParts);
      expect(attempts).toHaveLength(expected.length);
      for (const [index, attempt] of attempts.entries()) {
        expect(attempt.outcome).toBe("accepted");
        if (platform === "wechat") {
          expect(attempt.receipt).not.toHaveProperty("messageId");
          expect(attempt.receipt).toMatchObject({ conversationId: WECHAT_USER });
        } else expect(attempt.receipt).toMatchObject({ messageId: messages()[index].id });
        if (completed) expect(attempt.operation).toBe("settle");
      }
      expect(active!.messages().find((message) => message.type === "turn_end")).toMatchObject({
        status: {
          cancelled: "interrupted",
          failed: "error",
          completed: "completed",
          steered: "completed",
        }[outcome],
      });
      const transcript = await rome.db.select().from(romeAgentMessages);
      const replies = transcript.filter(
        (message) =>
          message.role === "assistant" &&
          (platform === "wechat"
            ? message.replyToPlatformMessageId === incomingId
            : message.platformMessageId),
      );
      expect(replies).toHaveLength(outcome === "completed" || outcome === "steered" ? 1 : 0);
      if (outcome === "completed" || outcome === "steered")
        expect(JSON.parse(replies[0].content)).toEqual([{ type: "text", content: finalText }]);
      if (outcome === "steered") {
        const inputs = transcript.filter((message) => message.role === "user");
        expect(inputs).toHaveLength(2);
        expect(inputs.every((message) => message.inputState === "consumed")).toBe(true);
        expect(new Set(inputs.map((message) => message.turnId)).size).toBe(1);
        expect(model).toHaveBeenCalledTimes(1);
      }
      expect(fixture.server.calls.filter(isUpdate)).toHaveLength(
        behavior === "edit" && outcome !== "cancelled" ? 3 : 0,
      );
      expect(fixture.server.calls.filter(isCreate)).toHaveLength(expected.length);
      fixture.server.assertClean();
    } finally {
      for (const gate of gates) gate.resolve();
      await Promise.allSettled(providerRuns);
      child.emit("exit", 0);
      await registry.stopAll();
      await fixture.close();
      await rome.cleanup();
      model.mockRestore();
      sessionModel.mockRestore();
    }
  });
});
