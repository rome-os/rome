import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ConversationDescriptor,
  ConversationId,
  ConversationRef,
  TalkDirectory,
} from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { DrizzleGrantLedger } from "../connections/ledger-db.js";
import { ConnectionRegistry } from "../connections/registry.js";
import type { ConnectionDescriptor, Talker } from "../connections/types.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { ConversationSettingsRepository } from "./repository.js";
import { ConversationSettingsService } from "./service.js";

function directoryDescriptor(
  service: "discord" | "feishu" | "wechat",
  conversations: (connectionId: string) => ConversationDescriptor[],
): ConnectionDescriptor {
  return {
    service,
    auth: {},
    capabilities: {
      talker: {
        needs: [],
        build(_creds, kit): Talker {
          const directory: TalkDirectory = {
            async listConversations(input) {
              const all = conversations(kit.connectionId).filter(
                (conversation) => input.includeTopics || conversation.kind !== "topic",
              );
              return {
                conversations: all.slice(0, input.limit),
                ...(all.length > input.limit ? { nextCursor: String(input.limit) } : {}),
              };
            },
          };
          return {
            start() {},
            stop() {},
            async send(conversationId) {
              return { conversationId };
            },
            feature: (name) => (name === "directory" ? directory : null) as never,
          };
        },
      },
    },
  };
}

describe("ConversationSettingsService", () => {
  let testDb: TestDb | undefined;

  afterEach(() => testDb?.close());

  async function setup(onChanged = rs.fn()) {
    testDb = createTestDb();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(testDb.db) });
    registry.register(
      directoryDescriptor("discord", (connectionId) => [
        {
          ref: { connectionId, conversationId: "parent" as ConversationId },
          service: "discord",
          kind: "channel",
          displayName: "general",
          containerName: "Rome",
        },
        {
          ref: { connectionId, conversationId: "child" as ConversationId },
          service: "discord",
          kind: "topic",
          displayName: "launch thread",
          containerName: "Rome",
          parent: { connectionId, conversationId: "parent" as ConversationId },
        },
      ]),
    );
    registry.register(directoryDescriptor("feishu", () => []));
    registry.register(directoryDescriptor("wechat", () => []));
    const discord = await registry.connect("discord");
    const feishu = await registry.connect("feishu");
    const wechat = await registry.connect("wechat");
    const repository = new ConversationSettingsRepository(testDb.db);
    const service = new ConversationSettingsService({
      repository,
      connections: registry,
      listAgents: () => ["pm-assistant"],
      onChanged,
    });
    const listed = await service.list();
    const parent = listed.items.find(
      (item) => item.snapshot.conversation.ref.conversationId === "parent",
    )!.snapshot.conversation.ref;
    const childDescriptor: ConversationDescriptor = {
      ref: { connectionId: discord.id, conversationId: "child" as ConversationId },
      service: "discord",
      kind: "topic",
      displayName: "launch thread",
      containerName: "Rome",
      parent,
    };
    service.observe(childDescriptor);
    return {
      registry,
      repository,
      service,
      changed: onChanged,
      discord,
      feishu,
      wechat,
      parent,
      child: childDescriptor.ref,
      childDescriptor,
      listed,
    };
  }

  it("keeps settings on the parent while threads inherit without overrides", async () => {
    const { repository, service, changed, parent, child, childDescriptor, listed } = await setup();

    expect(listed.items.map((item) => item.snapshot.conversation.ref.conversationId)).toEqual([
      "parent",
    ]);

    await expect(service.get(parent)).resolves.toMatchObject({
      effective: {
        enabled: true,
        activation: { mode: "mention" },
        replies: { placement: "thread" },
        routing: { agentName: null },
      },
      overrides: {},
    });

    await service.update({
      ref: parent,
      set: {
        enabled: false,
        activation: { mode: "all" },
        routing: { agentName: "pm-assistant" },
        session: { reset: { mode: "daily", atHour: 4 } },
      },
      clear: [],
      actor: { kind: "guardian", id: "guardian-1", displayName: "Ray" },
    });

    // Simulate a stale child override written by the previous model. Thread
    // reads must ignore it and resolve the parent as the sole settings owner.
    repository.mutate(childDescriptor, {
      settings: {
        schemaVersion: 1,
        overrides: { enabled: true },
        updatedAt: "2026-08-01T00:00:00.000Z",
        updatedBy: { kind: "system", id: "legacy-thread-override" },
      },
      agentName: null,
    });
    await expect(service.get(child)).resolves.toMatchObject({
      inheritedFrom: parent,
      effective: {
        enabled: false,
        activation: { mode: "all" },
        routing: { agentName: "pm-assistant" },
        session: { reset: { mode: "daily", atHour: 4 } },
      },
      overrides: {},
      updatedBy: { kind: "guardian", id: "guardian-1", displayName: "Ray" },
    });

    await expect(
      service.update({
        ref: child,
        set: { enabled: true },
        clear: [],
        actor: { kind: "guardian", id: "guardian-1" },
      }),
    ).rejects.toThrow(
      'Conversation "child" is a thread and follows parent "parent"; update the parent conversation instead',
    );
    await expect(
      service.reset({ ref: child, actor: { kind: "guardian", id: "guardian-1" } }),
    ).rejects.toThrow(
      'Conversation "child" is a thread and follows parent "parent"; update the parent conversation instead',
    );

    const reset = await service.reset({
      ref: parent,
      actor: { kind: "system", id: "test" },
    });
    expect(reset.overrides).toEqual({});
    expect(reset.effective.enabled).toBe(true);
    expect(reset.effective.routing.agentName).toBeNull();
    expect(reset.effective.session.reset).toEqual({ mode: "idle", idleMinutes: 10_080 });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("reconciles a first-seen topic placeholder with its persisted parent", async () => {
    const { service, discord, parent } = await setup();
    const child: ConversationRef = {
      connectionId: discord.id,
      conversationId: "first-seen-topic" as ConversationId,
    };

    const placeholder = await service.get(child);
    expect(placeholder).toMatchObject({
      conversation: { kind: "channel", displayName: "first-seen-topic" },
    });
    expect(placeholder).not.toHaveProperty("inheritedFrom");
    await service.update({
      ref: parent,
      set: { session: { reset: { mode: "daily", atHour: 4 } } },
      clear: [],
      actor: { kind: "guardian", id: "guardian-1" },
    });
    await new WebChatRepository(testDb!.db).ensureChannelConversation({
      channel: "discord",
      threadId: "first-seen-topic",
      parentThreadId: "parent",
      threadName: "Late topic",
      threadType: "group",
      agentName: "main",
    });

    await expect(service.get(child)).resolves.toMatchObject({
      conversation: {
        displayName: "Late topic",
        parent,
      },
      inheritedFrom: parent,
      effective: { session: { reset: { mode: "daily", atHour: 4 } } },
    });
  });

  it("round-trips reset modes and rejects invalid atomic values", async () => {
    const { service, parent } = await setup();
    await expect(service.get(parent)).resolves.toMatchObject({
      effective: { session: { reset: { mode: "idle", idleMinutes: 10_080 } } },
    });

    for (const reset of [
      { mode: "none" as const },
      { mode: "idle" as const, idleMinutes: 90 },
      { mode: "daily" as const, atHour: 4 },
    ]) {
      await expect(
        service.update({
          ref: parent,
          set: { session: { reset } },
          clear: [],
          actor: { kind: "guardian" },
        }),
      ).resolves.toMatchObject({ effective: { session: { reset } } });
    }

    await expect(
      service.update({
        ref: parent,
        set: { session: { reset: { mode: "idle", idleMinutes: 0 } as never } },
        clear: [],
        actor: { kind: "guardian" },
      }),
    ).rejects.toThrow("idleMinutes");
    await expect(
      service.update({
        ref: parent,
        set: { session: { reset: { mode: "daily", atHour: 24 } as never } },
        clear: [],
        actor: { kind: "guardian" },
      }),
    ).rejects.toThrow("atHour");

    await expect(
      service.update({
        ref: parent,
        set: {},
        clear: ["session.reset"],
        actor: { kind: "guardian" },
      }),
    ).resolves.toMatchObject({
      effective: { session: { reset: { mode: "idle", idleMinutes: 10_080 } } },
      overrides: {},
    });
  });

  it("lists only established direct messages and lets them own only session.reset", async () => {
    const { service, repository, changed, discord } = await setup();
    const webchat = new WebChatRepository(testDb!.db);
    await webchat.ensureChannelConversation({
      channel: "discord",
      threadId: "dm-1",
      threadName: "Ray",
      threadType: "private",
      agentName: "main",
    });
    const ref: ConversationRef = {
      connectionId: discord.id,
      conversationId: "dm-1" as ConversationId,
    };
    const listed = await service.list();
    expect(listed.items.map((item) => item.snapshot.conversation.ref.conversationId)).not.toContain(
      "dm-1",
    );
    await expect(service.get(ref)).resolves.toMatchObject({
      supportedFields: ["session.reset"],
      effective: {
        enabled: true,
        activation: { mode: "mention" },
        replies: { placement: "thread" },
        routing: { agentName: null },
        session: { reset: { mode: "idle", idleMinutes: 10_080 } },
      },
      overrides: {},
    });
    await expect(
      service.update({
        ref,
        set: { enabled: false },
        clear: [],
        actor: { kind: "guardian", id: "guardian-1" },
      }),
    ).rejects.toThrow('Unsupported conversation setting "enabled"');

    const updated = await service.update({
      ref,
      set: { session: { reset: { mode: "daily", atHour: 4 } } },
      clear: [],
      actor: { kind: "guardian", id: "guardian-1" },
    });
    expect(updated.overrides).toEqual({ session: { reset: { mode: "daily", atHour: 4 } } });
    expect((await service.list()).items.map((item) => item.snapshot.conversation.kind)).toContain(
      "dm",
    );

    const reset = await service.reset({
      ref,
      actor: { kind: "guardian", id: "guardian-1" },
    });
    expect(reset.effective.session.reset).toEqual({ mode: "idle", idleMinutes: 10_080 });
    expect(reset.overrides).toEqual({});

    const row = repository.find("discord", "dm-1" as ConversationId)!;
    await webchat.addConversationMessage({
      sessionId: row.id,
      role: "user",
      content: JSON.stringify([{ type: "text", content: "hello" }]),
      platformMessageId: "dm-message-1",
    });
    expect(
      (await service.list()).items.map((item) => item.snapshot.conversation.ref.conversationId),
    ).toContain("dm-1");

    expect(repository.find("discord", "dm-1" as ConversationId)).toMatchObject({
      sourceThreadType: "private",
      channelSettings: null,
    });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("validates actors, supported fields, agents, list source, and offline edits", async () => {
    const { registry, service, discord, feishu, wechat, parent } = await setup();

    await expect(
      service.update({
        ref: parent,
        set: { routing: { agentName: "missing-agent" } },
        clear: [],
        actor: { kind: "guardian" },
      }),
    ).rejects.toThrow('Agent "missing-agent" is not loaded');

    const feishuRef: ConversationRef = {
      connectionId: feishu.id,
      conversationId: "oc_group" as ConversationId,
    };
    service.observe({
      ref: feishuRef,
      service: "feishu",
      kind: "group",
      displayName: "Feishu group",
    });
    await expect(
      service.update({
        ref: feishuRef,
        set: { activation: { botMessages: "all" } },
        clear: [],
        actor: { kind: "guardian" },
      }),
    ).rejects.toThrow('Unsupported conversation setting "activation.botMessages"');

    const wechatRef: ConversationRef = {
      connectionId: wechat.id,
      conversationId: "wechat-contact" as ConversationId,
    };
    service.observe({
      ref: wechatRef,
      service: "wechat",
      kind: "group",
      displayName: "WeChat conversation",
    });
    await expect(service.get(wechatRef)).resolves.toMatchObject({
      supportedFields: ["enabled", "routing.agentName", "session.reset"],
    });
    await expect(
      service.update({
        ref: wechatRef,
        set: { enabled: false, routing: { agentName: "pm-assistant" } },
        clear: [],
        actor: { kind: "guardian", id: "guardian-1" },
      }),
    ).resolves.toMatchObject({
      effective: { enabled: false, routing: { agentName: "pm-assistant" } },
    });
    await expect(
      service.update({
        ref: wechatRef,
        set: { activation: { mode: "all" } },
        clear: [],
        actor: { kind: "guardian", id: "guardian-1" },
      }),
    ).rejects.toThrow('Unsupported conversation setting "activation.mode"');
    await expect(
      service.update({
        ref: parent,
        set: { providerOption: true } as never,
        clear: [],
        actor: { kind: "guardian" },
      }),
    ).rejects.toThrow('Unsupported conversation setting "providerOption"');
    await expect(
      service.update({
        ref: parent,
        set: { enabled: false },
        clear: [],
        actor: { kind: "guardian" },
      }),
    ).resolves.toMatchObject({ updatedBy: { kind: "guardian" } });

    expect(
      (await service.list()).items.find(
        (item) => item.snapshot.conversation.ref.conversationId === "parent",
      )?.source,
    ).toBe("configured");

    await registry.stopAll();
    expect(discord.talk).toBeNull();
    await expect(
      service.update({
        ref: parent,
        set: { replies: { placement: "inline" } },
        clear: [],
        actor: { kind: "system" },
      }),
    ).resolves.toMatchObject({ effective: { replies: { placement: "inline" } } });
    expect((await service.list({ connectionId: discord.id })).items[0]?.availability).toBe(
      "offline",
    );
  });

  it("hides persisted settings after their connection is removed", async () => {
    const { registry, repository, service, discord, wechat, parent } = await setup();
    await service.update({
      ref: parent,
      set: { enabled: false },
      clear: [],
      actor: { kind: "guardian" },
    });

    const wechatRef: ConversationRef = {
      connectionId: wechat.id,
      conversationId: "wechat-group" as ConversationId,
    };
    service.observe({
      ref: wechatRef,
      service: "wechat",
      kind: "group",
      displayName: "WeChat group",
    });
    await service.update({
      ref: wechatRef,
      set: { enabled: false },
      clear: [],
      actor: { kind: "guardian" },
    });

    await registry.remove(discord.id);

    const page = await service.list();
    expect(page.items.map((item) => item.snapshot.conversation.service)).toEqual(["wechat"]);
    expect(repository.find("discord", "parent" as ConversationId)?.channelSettings).not.toBeNull();
  });

  it("serializes concurrent writers per conversation", async () => {
    let releaseFirst!: () => void;
    const onChanged = rs.fn(
      () =>
        new Promise<void>((resolve) => {
          if (onChanged.mock.calls.length === 1) releaseFirst = resolve;
          else resolve();
        }),
    );
    const { service, parent } = await setup(onChanged);

    const first = service.update({
      ref: parent,
      set: { enabled: false },
      clear: [],
      actor: { kind: "guardian", id: "first" },
    });
    await rs.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const second = service.update({
      ref: parent,
      set: { enabled: true },
      clear: [],
      actor: { kind: "guardian", id: "second" },
    });
    await Promise.resolve();
    expect(onChanged).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(onChanged).toHaveBeenCalledTimes(2);
    expect((await service.get(parent)).effective.enabled).toBe(true);
    expect((await service.get(parent)).updatedBy).toEqual({ kind: "guardian", id: "second" });
  });

  it("paginates beyond a bounded live directory first page", async () => {
    testDb = createTestDb();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(testDb.db) });
    registry.register(
      directoryDescriptor("discord", (connectionId) =>
        Array.from({ length: 5 }, (_, index) => ({
          ref: {
            connectionId,
            conversationId: `channel-${index}` as ConversationId,
          },
          service: "discord",
          kind: "channel" as const,
          displayName: `channel-${index}`,
        })),
      ),
    );
    await registry.connect("discord");
    const service = new ConversationSettingsService({
      repository: new ConversationSettingsRepository(testDb.db),
      connections: registry,
      listAgents: () => [],
    });

    const first = await service.list({ limit: 2 });
    expect(first.items.map((entry) => entry.snapshot.conversation.displayName)).toEqual([
      "channel-0",
      "channel-1",
    ]);
    expect(first.nextCursor).toBeTruthy();

    const second = await service.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((entry) => entry.snapshot.conversation.displayName)).toEqual([
      "channel-2",
      "channel-3",
    ]);
    expect(second.nextCursor).toBeTruthy();
  });

  it("hydrates only the requested page and skips persisted native threads early", async () => {
    testDb = createTestDb();
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(testDb.db) });
    registry.register(directoryDescriptor("discord", () => []));
    const discord = await registry.connect("discord");
    const repository = new ConversationSettingsRepository(testDb.db);
    const descriptors = Array.from({ length: 5 }, (_, index) => ({
      ref: {
        connectionId: discord.id,
        conversationId: `channel-${index}` as ConversationId,
      },
      service: "discord",
      kind: "channel" as const,
      displayName: `channel-${index}`,
    }));
    for (const descriptor of descriptors) {
      repository.mutate(descriptor, { settings: null, agentName: null });
    }
    repository.mutate(
      {
        ref: { connectionId: discord.id, conversationId: "topic-1" as ConversationId },
        service: "discord",
        kind: "topic",
        displayName: "topic-1",
        parent: descriptors[0]!.ref,
      },
      { settings: null, agentName: null },
    );
    const find = rs.spyOn(repository, "find");
    const listKnown = rs.spyOn(repository, "listKnown");
    const service = new ConversationSettingsService({
      repository,
      connections: registry,
      listAgents: () => [],
    });

    const first = await service.list({ limit: 2 });

    expect(first.items.map((entry) => entry.snapshot.conversation.displayName)).toEqual([
      "channel-0",
      "channel-1",
    ]);
    expect(find).toHaveBeenCalledTimes(2);
    expect(listKnown).toHaveBeenCalledTimes(1);
    expect(first.nextCursor).toBeTruthy();
  });
});
