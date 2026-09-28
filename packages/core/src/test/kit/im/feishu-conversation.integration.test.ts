import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ConversationId } from "@rome-os/app-runtime";
import { createTestRome } from "../test-rome.js";
import { buildAction } from "../builders.js";
import { errorMessage, result, text, thinking } from "../fake-model.js";
import { createLarkServerStub, LARK_CHAT, LARK_USER } from "./lark.js";
import { ConnectionRegistry } from "../../../connections/registry.js";
import { DrizzleGrantLedger } from "../../../connections/ledger-db.js";
import { createFeishuDescriptor } from "../../../connections/integrations/feishu.js";
import { createTalkRouter } from "../../../connections/talk-router.js";
import { createPairingAdmission } from "../../../channels/pairing.js";
import { ConversationSettingsRepository } from "../../../conversation-settings/repository.js";
import { ConversationSettingsService } from "../../../conversation-settings/service.js";
import { ReplyDeliveryRepository } from "../../../db/repositories/reply-delivery.js";
import { SentinelLogRepository } from "../../../db/repositories/sentinel-log.js";
import { WebChatRepository } from "../../../db/repositories/webchat.js";
import { actionExecutions, romeAgentMessages } from "../../../db/schema.js";
import { PolicyEngine } from "../../../core/policy-engine.js";
import { stopActiveConversationTurn } from "../../../core/chat-stop.js";
import { createAgentTurnStreamRegistry } from "../../../core/agent-turn-stream-registry.js";
import { createBackendTurnRunner } from "../../../actions/backend-turn.js";
import { createAppDomain } from "../../../apps/index.js";
import { createRomeAppContext } from "../../../apps/context.js";
import { createAppRuntimeRepositories } from "../../../apps/repositories.js";
import { getProfileDir } from "../../../paths.js";
import { ChannelMessageHook } from "../../../../../../rome_apps/inbox/src/hooks/channel-message/index.js";
import { createMessageHandlerAction } from "../../../../../../rome_apps/inbox/src/actions/message-handler/index.js";
import { createSendMessageAction } from "../../../../../../rome_apps/system/src/actions/send-message/index.js";

async function createConversationStack() {
  const rome = await createTestRome();
  const stub = await createLarkServerStub();
  const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(rome.db) });
  const conversationSettings = new ConversationSettingsService({
    repository: new ConversationSettingsRepository(rome.db),
    connections: registry,
    listAgents: () => [],
  });
  const people = rome.repos.personMapping;
  const guardian = await people.create({
    displayName: "Alice",
    bondLevel: "guardian",
    approved: true,
  });
  await people.addChannelMapping(guardian, "feishu", LARK_USER, "Alice");
  registry.register(
    createFeishuDescriptor({
      conversationSettings,
      personMappingRepo: people,
      listAgents: () => [],
      createChannel: (config) => stub.createChannel(config),
    }),
  );
  const router = createTalkRouter(
    registry,
    createPairingAdmission({
      approvalsRepo: rome.repos.approvals,
      personMappingRepo: people,
      talkGrants: () => ["app"],
    }),
    rome.repos.settings,
    new ReplyDeliveryRepository(rome.db),
  );
  const connection = await registry.connect("feishu");
  await registry.importCredential(connection.id, "app", {
    material: { appId: stub.appId, appSecret: stub.appSecret },
    expiresAt: "never",
  });
  await stub.untilConnected();
  const webchat = new WebChatRepository(rome.db);
  const repositories = createAppRuntimeRepositories({
    settingsRepo: rome.repos.settings,
    webchatRepo: webchat,
  });
  const root = getProfileDir();
  const { catalog } = createAppDomain({ lockfilePath: join(root, "apps.lock.json") });
  const appContext = createRomeAppContext(
    {
      appId: "inbox",
      state: "installed",
      enabled: true,
      firstParty: true,
      source: { mode: "bundle", path: root },
      installedHash: "0".repeat(64),
      installedVersion: "0.0.1",
      lastError: null,
      updatedAt: "2026-09-18T00:00:00.000Z",
      manifest: {
        id: "inbox",
        version: "0.0.1",
        description: "Inbox",
        agents: [],
        actions: [],
        skills: [],
        hooks: [],
      },
      rootPath: root,
      resolveRoot: root,
      displayName: "Inbox",
      iconAbsolutePath: undefined,
      artifacts: { agent: [], action: [], skill: [], hook: [] },
      web: null,
      api: null,
      db: null,
    },
    { catalog, db: rome.db, actionEngine: rome.actionEngine, repositories },
  );
  rome.actionRegistry.register(
    createSendMessageAction(buildAction("send_message", { sideEffects: "write" }).config, router, {
      personMappingRepo: people,
      conversations: repositories.conversations,
    }),
  );
  rome.actionRegistry.register(
    createMessageHandlerAction(
      buildAction("message_handler", { sideEffects: "write", complexity: "complex", speed: "slow" })
        .config,
      {
        appContext,
        agentRunner: rome.agentRunner,
        personMappingRepo: people,
        sentinelLogRepo: new SentinelLogRepository(rome.db),
        approvalsRepo: rome.repos.approvals,
        policyEngine: new PolicyEngine(rome.repos.policies, rome.repos.settings),
        resolveProfilePath: (path) => join(root, path),
        strangerPersonId: "__STRANGER__",
      },
    ),
  );
  const turns = createAgentTurnStreamRegistry();
  const hook = new ChannelMessageHook(rome.actionEngine, router, conversationSettings, (input) =>
    stopActiveConversationTurn(input, {
      turns,
      isGuardian: async (service, senderId) =>
        (await people.findByChannelUser(service, senderId))?.bondLevel === "guardian",
    }),
  );
  await hook.register();
  return {
    rome,
    stub,
    router,
    connection,
    repositories,
    webchat,
    async send(input: string, eventId: string, expectedStatus = "success", chatId = LARK_CHAT) {
      const previous = await rome.db
        .select()
        .from(actionExecutions)
        .where(eq(actionExecutions.actionName, "message_handler"));
      await stub.emitMessage(input, eventId, chatId);
      await rs.waitFor(async () => {
        const runs = await rome.db
          .select()
          .from(actionExecutions)
          .where(eq(actionExecutions.actionName, "message_handler"));
        expect(runs).toHaveLength(previous.length + 1);
        expect(runs.find((run) => !previous.some((old) => old.id === run.id))?.status).toBe(
          expectedStatus,
        );
      });
    },
    async messages() {
      return rome.db.select().from(romeAgentMessages);
    },
    async close() {
      hook.unregister();
      await registry.stopAll();
      await stub.close();
      await rome.cleanup();
    },
  };
}

describe("Feishu conversation through the SDK, inbox and real agent runtime", () => {
  let stack: Awaited<ReturnType<typeof createConversationStack>>;
  beforeEach(async () => {
    stack = await createConversationStack();
  });
  afterEach(async () => {
    await stack?.close();
  });

  it("delivers only the final result, persists provider ids, and reuses the conversation on the next turn", async () => {
    const { rome, stub } = stack;
    rome.model.queueReply(thinking("private reasoning"), text("draft"), result("first answer"));
    await stack.send("first question", "first");
    const first = await rome.repos.sessions.findByChannelThreadKey(`feishu:${LARK_CHAT}`, "main");
    expect(first).not.toBeNull();
    rome.model.queueReply(result("second answer"));
    await stack.send("second question", "second");
    expect(
      (await rome.repos.sessions.findByChannelThreadKey(`feishu:${LARK_CHAT}`, "main"))?.id,
    ).toBe(first?.id);
    expect(rome.model.calls).toHaveLength(2);
    expect(rome.model.prompts()[0]).toContain("first question");
    expect(rome.model.prompts()[1]).toContain("second question");
    const replies = [...stub.messages.values()].filter(
      (message) => message.sender?.sender_type === "app",
    );
    expect(replies).toHaveLength(2);
    expect(replies.map((message) => message.msg_type)).toEqual(["post", "post"]);
    expect(replies.map((message) => JSON.parse(message.body.content))).toEqual([
      { zh_cn: { title: "", content: [[{ tag: "md", text: "first answer" }]] } },
      { zh_cn: { title: "", content: [[{ tag: "md", text: "second answer" }]] } },
    ]);
    expect(replies.map((message) => message.parent_id)).toEqual(["om_first", "om_second"]);
    const messages = (await stack.messages()).filter((message) => message.role !== "trace");
    expect(new Set(messages.map((message) => message.sessionId)).size).toBe(1);
    expect(
      messages
        .filter((message) => message.role === "user")
        .map((message) => message.platformMessageId),
    ).toEqual(["om_first", "om_second"]);
    expect(
      messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.platformMessageId),
    ).toEqual(replies.map((message) => message.message_id));
    expect(stub.server.calls.filter((call) => ["PATCH", "PUT"].includes(call.method))).toHaveLength(
      0,
    );
    stub.server.assertClean();
  });

  it("delivers a backend continuation into the same conversation and records its provider receipt", async () => {
    const { rome, stub, router, connection, repositories } = stack;
    rome.model.queueReply(result("initial answer"));
    await stack.send("start a task", "start");
    const session = await rome.repos.sessions.findByChannelThreadKey(`feishu:${LARK_CHAT}`, "main");
    expect(session).not.toBeNull();
    const before = await stack.messages();
    rome.model.queueReply({ type: "text_delta", content: "task " }, result("task completed"));
    await createBackendTurnRunner({
      agentRunner: rome.agentRunner,
      talkRouter: router,
      conversations: repositories.conversations,
      createRunDelivery: (params, turnId) =>
        router.createRunDelivery(connection.id, turnId, {
          conversationId: params.threadId as ConversationId,
        }),
    }).runAndDeliver({
      agentName: "main",
      sessionId: session!.id,
      connectionId: connection.id,
      channel: "feishu",
      threadId: LARK_CHAT,
      channelUserId: LARK_USER,
      prompt: "continue the task",
    });
    const replies = [...stub.messages.values()].filter(
      (message) => message.sender?.sender_type === "app",
    );
    expect(replies).toHaveLength(2);
    expect(JSON.parse(replies[1].body.content)).toEqual({
      text: "task completed",
    });
    const recorded = (await stack.messages()).filter((message) => message.role === "assistant");
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toMatchObject({
      sessionId: before[0].sessionId,
      platformMessageId: replies[1].message_id,
    });
    expect(rome.model.calls).toHaveLength(2);
    expect(
      (await rome.repos.sessions.findByChannelThreadKey(`feishu:${LARK_CHAT}`, "main"))?.id,
    ).toBe(session!.id);
    stub.server.assertClean();
  });

  it.each([
    "empty",
    "error",
  ] as const)("does not send partial text when the model ends with %s", async (outcome) => {
    const { rome, stub } = stack;
    rome.model.queueReply(
      text("unfinished draft"),
      outcome === "empty" ? result("") : errorMessage("model unavailable"),
    );
    await stack.send("question", outcome, outcome === "error" ? "error" : "success");
    expect(rome.model.calls).toHaveLength(1);
    expect(
      [...stub.messages.values()].filter((message) => message.sender?.sender_type === "app"),
    ).toHaveLength(0);
    expect((await stack.messages()).filter((message) => message.role === "user")).toHaveLength(1);
    expect(
      (await stack.messages()).filter(
        (message) => message.platformMessageId && message.role === "assistant",
      ),
    ).toHaveLength(0);
    stub.server.assertClean();
  });

  it("isolates conversations and reply destinations for the same sender in different chats", async () => {
    const { rome, stub } = stack;
    rome.model.queueReply(result("answer A")).queueReply(result("answer B"));
    await stack.send("question A", "chat_a");
    await stack.send("question B", "chat_b", "success", "oc_second_chat");
    const first = await rome.repos.sessions.findByChannelThreadKey(`feishu:${LARK_CHAT}`, "main");
    const second = await rome.repos.sessions.findByChannelThreadKey(
      "feishu:oc_second_chat",
      "main",
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);
    const messages = await stack.messages();
    expect(new Set(messages.map((message) => message.sessionId)).size).toBe(2);
    for (const [event, chat] of [
      ["chat_a", LARK_CHAT],
      ["chat_b", "oc_second_chat"],
    ]) {
      const reply = [...stub.messages.values()].find(
        (message) => message.parent_id === `om_${event}`,
      );
      expect(reply?.chat_id).toBe(chat);
      expect(
        messages.find((message) => message.platformMessageId === reply?.message_id)?.sessionId,
      ).toBe(messages.find((message) => message.platformMessageId === `om_${event}`)?.sessionId);
    }
    stub.server.assertClean();
  });

  it("retains the input without a delivered assistant receipt when Feishu rejects the reply", async () => {
    const { rome, stub } = stack;
    const path = "/open-apis/im/v1/messages/om_refused/reply";
    stub.server.once({
      method: "POST",
      path,
      response: {
        status: 403,
        body: { code: 230006, msg: "Bot is not in the conversation" },
      },
    });
    rome.model.queueReply(result("undeliverable answer"));
    await stack.send("question", "refused", "error");
    expect(rome.model.calls).toHaveLength(1);
    expect(stub.messages.size).toBe(1);
    expect(stub.server.calls.filter((call) => call.path === path)).toHaveLength(1);
    const messages = await stack.messages();
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(
      messages.filter((message) => message.role === "assistant" && message.platformMessageId),
    ).toHaveLength(0);
    stub.server.assertClean();
  });
});
