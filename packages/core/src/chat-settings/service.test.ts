import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { sql } from "drizzle-orm";
import type { ChatDescriptor, ChatId, ChatRef, EnsureChannelChatInput } from "@rome-os/app-runtime";
import type { TalkDirectory } from "../connections/types.js";
import { createTestDb, kindChannelOf, testChatsWiring, type TestDb } from "../test/helpers.js";
import { DrizzleConnectionsRepository } from "../connections/repository-db.js";
import { ConnectionRegistry } from "../connections/registry.js";
import { tokenPaste } from "../connections/schemes.js";
import type { Channels } from "../chats/connected-accounts/connected-account.js";
import { connectionPorts } from "../chats/connected-accounts/connection-ports.js";
import type { ConnectionDescriptor, Talker } from "../connections/types.js";
import { chatsWiring } from "../chats-wiring.js";
import { openChannelChat } from "../connections/open-chat.js";
import { startChannelChat } from "../connections/channel-chat.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn } from "../chats/storage/place.js";
import { ChatAddresses } from "../connections/chat-addresses.js";
import { ChatSettingsRepository } from "./repository.js";
import { ChatSettingsService } from "./service.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";

function directoryDescriptor(
  service: "discord" | "feishu" | "wechat" | "agents",
  conversations: (connectionId: string) => ChatDescriptor[],
): ConnectionDescriptor {
  return {
    connectionKind: service,
    grant: "bot",
    auth: tokenPaste({ label: "token", validate: async () => {} }),
    capabilities: {
      talker: {
        build(_cred, kit): Talker {
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
            async send(chatId) {
              return { chatId };
            },
            directory,
          };
        },
      },
    },
  };
}

/** Connects `kind` and gives it access, so its Talk is live. */
async function connectLive(registry: ConnectionRegistry, kind: string) {
  const connection = await registry.connect(kind);
  await registry.giveGrant(connection.connectionKind, connection.id, "bot", {
    material: { token: "token" },
    expiresAt: "never",
  });
  return connection;
}

/** The channels the registry's Talks back, built by the production ports,
 *  once per service as `channelList` builds them. */
function channelsOver(registry: ConnectionRegistry): () => Channels {
  const built = new Map<string, ReturnType<typeof connectionPorts>>();
  return () =>
    registry.registeredKinds().flatMap((name) => {
      if (!built.has(name))
        built.set(name, connectionPorts({ registry, channelOf: kindChannelOf }, name));
      const ports = built.get(name);
      return ports ? [{ name, accounts: null, messages: null, ...ports }] : [];
    });
}

/** The speaker of the channel's account at a channel address, in the chat
 *  the address keys, as a message reaching it opens it. */
function openSpeaker(
  db: TestDb["db"],
  input: EnsureChannelChatInput,
  wired: ReturnType<typeof chatsWiring> = testChatsWiring(db),
) {
  return openChannelChat(
    {
      webchatRepo: new ChatsWebChatRepository(db),
      speakers: { chats: wired.chats, adapters: wired.adapters, speakers: wired.speakers },
    },
    input,
  );
}

describe("ChatSettingsService", () => {
  let testDb: TestDb | undefined;

  afterEach(() => testDb?.close());

  async function setup(onChanged = rs.fn()) {
    testDb = createTestDb();
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
    });
    registry.register(
      directoryDescriptor("discord", (connectionId) => [
        {
          ref: { connectionId, chatId: "parent" as ChatId },
          connectionKind: "discord",
          service: "discord",
          kind: "channel",
          displayName: "general",
          containerName: "Rome",
        },
        {
          ref: { connectionId, chatId: "child" as ChatId },
          connectionKind: "discord",
          service: "discord",
          kind: "topic",
          displayName: "launch thread",
          containerName: "Rome",
          parent: { connectionId, chatId: "parent" as ChatId },
        },
      ]),
    );
    registry.register(directoryDescriptor("feishu", () => []));
    registry.register(directoryDescriptor("wechat", () => []));
    const discord = await connectLive(registry, "discord");
    const feishu = await connectLive(registry, "feishu");
    const wechat = await connectLive(registry, "wechat");
    const repository = new ChatSettingsRepository(testDb.db, testChatsWiring(testDb.db));
    const service = new ChatSettingsService({
      repository,
      connections: registry,
      channelOf: kindChannelOf,
      channels: channelsOver(registry),
      listAgents: () => ["pm-assistant"],
      onChanged,
    });
    const listed = await service.list();
    const parent = listed.items.find((item) => item.snapshot.conversation.ref.chatId === "parent")!
      .snapshot.conversation.ref;
    const childDescriptor: ChatDescriptor = {
      ref: { connectionId: discord.id, chatId: "child" as ChatId },
      connectionKind: "discord",
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

  it("places what it stores in chats, and leaves the legacy source columns empty", async () => {
    const { repository, service, parent, childDescriptor } = await setup();
    await service.update({
      ref: parent,
      set: { enabled: false },
      clear: [],
      actor: { kind: "guardian", id: "guardian-1" },
    });
    repository.mutate(childDescriptor, childDescriptor.connectionKind, {
      settings: null,
      agentName: undefined,
    });

    const rows = testDb!.db.all<{
      thread_id: string | null;
      chat_id: number | null;
      source_channel: string | null;
      source_thread_id: string | null;
      source_thread_name: string | null;
      source_thread_type: string | null;
    }>(sql`SELECT thread_id, chat_id, source_channel, source_thread_id, source_thread_name,
             source_thread_type FROM rome_sessions ORDER BY thread_id IS NOT NULL`);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.thread_id).toBe("child");
    for (const row of rows) {
      expect(row.chat_id).not.toBeNull();
      expect(row).toMatchObject({
        source_channel: null,
        source_thread_id: null,
        source_thread_name: null,
        source_thread_type: null,
      });
    }
  });

  it("keeps the legacy source columns on a thread whose parent Rome holds no speaker for", async () => {
    const { repository, childDescriptor } = await setup();
    repository.mutate(childDescriptor, childDescriptor.connectionKind, {
      settings: null,
      agentName: undefined,
    });

    // The legacy chats backfill places this row by its source columns.
    expect(
      testDb!.db.all(
        sql`SELECT chat_id, parent_session_id, source_channel, source_thread_id
            FROM rome_sessions WHERE thread_id = 'child'`,
      ),
    ).toEqual([
      {
        chat_id: null,
        parent_session_id: null,
        source_channel: "discord",
        source_thread_id: "child",
      },
    ]);
  });

  it("keeps settings on the parent while threads inherit without overrides", async () => {
    const { repository, service, changed, parent, child, childDescriptor, listed } = await setup();

    expect(listed.items.map((item) => item.snapshot.conversation.ref.chatId)).toEqual(["parent"]);

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
    repository.mutate(childDescriptor, childDescriptor.connectionKind, {
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

  it("resolves an observed thread with no session row through its parent", async () => {
    const { service, discord, parent } = await setup();
    await service.update({
      ref: parent,
      set: { enabled: false },
      clear: [],
      actor: { kind: "guardian" },
    });
    const thread: ChatRef = {
      connectionId: discord.id,
      chatId: "new-thread" as ChatId,
    };
    service.observe({
      ref: thread,
      connectionKind: "discord",
      service: "discord",
      kind: "topic",
      displayName: "new",
      parent,
    });

    await expect(service.get(thread)).resolves.toMatchObject({
      inheritedFrom: parent,
      effective: { enabled: false },
    });
  });

  it("reconciles a first-seen topic placeholder with its persisted parent", async () => {
    const { service, discord, parent } = await setup();
    const child: ChatRef = {
      connectionId: discord.id,
      chatId: "first-seen-topic" as ChatId,
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
    await openSpeaker(testDb!.db, {
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
    const webchat = new ChatsWebChatRepository(testDb!.db);
    await openSpeaker(testDb!.db, {
      channel: "discord",
      threadId: "dm-1",
      threadName: "Ray",
      threadType: "private",
      agentName: "main",
    });
    const ref: ChatRef = {
      connectionId: discord.id,
      chatId: "dm-1" as ChatId,
    };
    const listed = await service.list();
    expect(listed.items.map((item) => item.snapshot.conversation.ref.chatId)).not.toContain("dm-1");
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

    const row = repository.find("discord", "dm-1" as ChatId)!;
    await webchat.addConversationMessage({
      sessionId: row.id,
      role: "user",
      content: JSON.stringify([{ type: "text", content: "hello" }]),
      platformMessageId: "dm-message-1",
    });
    expect(
      (await service.list()).items.map((item) => item.snapshot.conversation.ref.chatId),
    ).toContain("dm-1");

    expect(repository.find("discord", "dm-1" as ChatId)).toMatchObject({
      kind: "dm",
      channelSettings: null,
    });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("lets a Rome Cloud direct message change its session reset", async () => {
    testDb = createTestDb();
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
    });
    registry.register(directoryDescriptor("agents", () => []));
    const agents = await connectLive(registry, "agents");
    const service = new ChatSettingsService({
      repository: new ChatSettingsRepository(testDb.db, testChatsWiring(testDb.db)),
      connections: registry,
      channelOf: kindChannelOf,
      channels: () => [],
      listAgents: () => [],
      onChanged: () => {},
    });
    await openSpeaker(testDb.db, {
      channel: "agents",
      threadId: "dm-1",
      threadType: "private",
      agentName: "main",
    });
    const ref: ChatRef = { connectionId: agents.id, chatId: "dm-1" as ChatId };

    const updated = await service.update({
      ref,
      set: { session: { reset: { mode: "daily", atHour: 4 } } },
      clear: [],
      actor: { kind: "guardian" },
    });

    expect(updated.overrides).toEqual({ session: { reset: { mode: "daily", atHour: 4 } } });
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

    const feishuRef: ChatRef = {
      connectionId: feishu.id,
      chatId: "oc_group" as ChatId,
    };
    service.observe({
      ref: feishuRef,
      connectionKind: "feishu",
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

    const wechatRef: ChatRef = {
      connectionId: wechat.id,
      chatId: "wechat-contact" as ChatId,
    };
    service.observe({
      ref: wechatRef,
      connectionKind: "wechat",
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
        (item) => item.snapshot.conversation.ref.chatId === "parent",
      )?.source,
    ).toBe("configured");

    await registry.stopAll();
    expect(discord.isUnlocked("chat")).toBe(false);
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

    const wechatRef: ChatRef = {
      connectionId: wechat.id,
      chatId: "wechat-group" as ChatId,
    };
    service.observe({
      ref: wechatRef,
      connectionKind: "wechat",
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
    expect(repository.find("discord", "parent" as ChatId)?.channelSettings).not.toBeNull();
  });

  it("reads no row for, and refuses updates on, a Connection that backs no channel", async () => {
    const { registry, service, discord, parent } = await setup();
    await service.update({
      ref: parent,
      set: { enabled: false },
      clear: [],
      actor: { kind: "guardian" },
    });
    // discord has lost its channel record, as while `registry.remove` evicts it.
    const unrecorded = new ChatSettingsService({
      repository: new ChatSettingsRepository(testDb!.db, testChatsWiring(testDb!.db)),
      connections: registry,
      channelOf: (connection) => (connection.id === discord.id ? null : connection.connectionKind),
      channels: () => [],
      listAgents: () => [],
      onChanged: () => {},
    });

    expect((await unrecorded.get(parent)).overrides).toEqual({});
    expect((await unrecorded.list({ connectionId: discord.id })).items).toEqual([]);
    await expect(
      unrecorded.update({
        ref: parent,
        set: { enabled: true },
        clear: [],
        actor: { kind: "guardian" },
      }),
    ).rejects.toThrow(`Connection "${discord.id}" backs no channel`);
  });

  it("still reads a seen conversation and its settings once its connection is removed", async () => {
    const { registry, service, wechat } = await setup();
    const ref: ChatRef = {
      connectionId: wechat.id,
      chatId: "wechat-group" as ChatId,
    };
    service.observe({
      ref,
      connectionKind: "wechat",
      service: "wechat",
      kind: "group",
      displayName: "WeChat group",
    });
    await service.update({ ref, set: { enabled: false }, clear: [], actor: { kind: "guardian" } });

    await registry.remove(wechat.id);

    const snapshot = await service.get(ref);
    expect(snapshot.conversation.displayName).toBe("WeChat group");
    expect(snapshot.effective.enabled).toBe(false);
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

  /** A service over one group two of Rome's accounts on Feishu are in. A
   *  second account of one kind is stood in for by another kind, whose channel
   *  the fake records put on Feishu. */
  async function twoAccountsInOneGroup(agents: string[] = [], observed = true) {
    testDb = createTestDb();
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
    });
    registry.register(directoryDescriptor("feishu", () => []));
    registry.register(directoryDescriptor("wechat", () => []));
    const sales = await connectLive(registry, "feishu");
    const support = await connectLive(registry, "wechat");
    // The account the sales channel is paired as, which a re-pairing
    // changes, and the channel it is, which a reconnect changes.
    const paired: { sales: string | null; salesChannel: string } = {
      sales: "ou_sales",
      salesChannel: "feishu",
    };
    const channelOf = (connection: { id: string }) =>
      connection.id === sales.id ? paired.salesChannel : "feishu-2";
    const wired = chatsWiring(testDb.db, {
      channelsOn: (platform) => (platform === "feishu" ? [paired.salesChannel, "feishu-2"] : []),
      accountOf: (name) =>
        name === paired.salesChannel
          ? paired.sales === null
            ? null
            : { platform: "feishu", id: paired.sales }
          : name === "feishu-2"
            ? { platform: "feishu", id: "ou_support" }
            : null,
      platformOfChannel: (name) => (name.startsWith("feishu") ? "feishu" : name),
    });
    const repository = new ChatSettingsRepository(testDb.db, wired);
    const service = new ChatSettingsService({
      repository,
      connections: registry,
      channelOf,
      channels: () => [],
      listAgents: () => agents,
      onChanged: () => {},
    });
    const throughSales = { connectionId: sales.id, chatId: "oc_group" as ChatId };
    const throughSupport = { connectionId: support.id, chatId: "oc_group" as ChatId };
    for (const ref of observed ? [throughSales, throughSupport] : []) {
      service.observe({
        ref,
        connectionKind: "feishu",
        service: "feishu",
        kind: "group",
        displayName: "Launch",
      });
    }

    /** Rome's speaker in the group through `channel`, opened by a message
     *  that names no kind. */
    const standIn = (channel: "feishu" | "feishu-2") =>
      openSpeaker(testDb!.db, { channel, threadId: "oc_group", agentName: "main" }, wired);

    return { registry, service, repository, wired, paired, standIn, throughSales, throughSupport };
  }

  it("serializes writers through two of Rome's accounts in one group", async () => {
    const { service, throughSales, throughSupport } = await twoAccountsInOneGroup();

    // Both start before either writes, so each would read the rule before
    // the other's change without one lock for the chat.
    await Promise.all([
      service.update({
        ref: throughSales,
        set: { enabled: false },
        clear: [],
        actor: { kind: "guardian" },
      }),
      service.update({
        ref: throughSupport,
        set: { activation: { mode: "all" } },
        clear: [],
        actor: { kind: "guardian" },
      }),
    ]);

    for (const ref of [throughSales, throughSupport]) {
      expect((await service.get(ref)).effective).toMatchObject({
        enabled: false,
        activation: { mode: "all" },
      });
    }
  });

  it("keeps a group's rule across the speakers of Rome's accounts in it", async () => {
    const { service, standIn, throughSales, throughSupport } = await twoAccountsInOneGroup();
    await standIn("feishu");
    await standIn("feishu-2");

    await service.update({
      ref: throughSales,
      set: { activation: { mode: "all" } },
      clear: [],
      actor: { kind: "guardian" },
    });
    await service.update({
      ref: throughSupport,
      set: { enabled: false },
      clear: [],
      actor: { kind: "guardian" },
    });

    for (const ref of [throughSales, throughSupport]) {
      expect((await service.get(ref)).effective).toMatchObject({
        enabled: false,
        activation: { mode: "all" },
      });
    }
  });

  it("keeps each of Rome's accounts' agent choice in a group its own", async () => {
    const { service, standIn, throughSales, throughSupport } = await twoAccountsInOneGroup([
      "pm-assistant",
    ]);
    await standIn("feishu");
    await standIn("feishu-2");

    await service.update({
      ref: throughSales,
      set: { routing: { agentName: "main" } },
      clear: [],
      actor: { kind: "guardian" },
    });
    expect((await service.get(throughSupport)).overrides.routing).toBeUndefined();
    await service.update({
      ref: throughSupport,
      set: { routing: { agentName: "pm-assistant" } },
      clear: [],
      actor: { kind: "guardian" },
    });

    expect((await service.get(throughSales)).overrides.routing).toEqual({ agentName: null });
    expect((await service.get(throughSupport)).overrides.routing).toEqual({
      agentName: "pm-assistant",
    });
  });

  it("refuses a rule at an address whose kind neither a speaker, its platform nor the address names", async () => {
    const { service, wired, throughSales } = await twoAccountsInOneGroup([], false);

    await expect(
      service.update({
        ref: throughSales,
        set: { session: { reset: { mode: "daily", atHour: 4 } } },
        clear: [],
        actor: { kind: "guardian" },
      }),
    ).rejects.toThrow("is a group or a direct message");
    expect(wired.chats.list("feishu")).toEqual([]);
  });

  it("reads a group's rule through an account with no speaker there, once Rome holds the group", async () => {
    const { service, standIn, throughSales, throughSupport } = await twoAccountsInOneGroup(
      [],
      false,
    );
    await standIn("feishu");
    await service.update({
      ref: throughSales,
      set: { enabled: false },
      clear: [],
      actor: { kind: "guardian" },
    });

    // Rome holds a group there through Sales, so the address is a group.
    expect((await service.get(throughSupport)).effective.enabled).toBe(false);
    await service.update({
      ref: throughSupport,
      set: { session: { reset: { mode: "none" } } },
      clear: [],
      actor: { kind: "guardian" },
    });
    for (const ref of [throughSales, throughSupport]) {
      expect((await service.get(ref)).effective).toMatchObject({
        enabled: false,
        session: { reset: { mode: "none" } },
      });
    }
  });

  it("reads a group's rule as the newest one Rome's speakers there hold", async () => {
    const { service, repository, standIn, throughSales, throughSupport } =
      await twoAccountsInOneGroup();
    await standIn("feishu");
    await standIn("feishu-2");
    // Rows from before the rule was shared hold rules of their own.
    const rule = (enabled: boolean, updatedAt: string) =>
      JSON.stringify({
        schemaVersion: 1,
        overrides: { enabled },
        updatedAt,
        updatedBy: { kind: "guardian" },
      });
    const [sales, support] = ["feishu", "feishu-2"].map(
      (channel) => repository.find(channel, "oc_group" as ChatId)!,
    );
    testDb!.db.run(
      sql`UPDATE rome_sessions SET channel_settings = ${rule(true, "2026-01-01T00:00:00.000Z")} WHERE id = ${sales!.id}`,
    );
    testDb!.db.run(
      sql`UPDATE rome_sessions SET channel_settings = ${rule(false, "2026-02-01T00:00:00.000Z")} WHERE id = ${support!.id}`,
    );

    for (const ref of [throughSales, throughSupport]) {
      expect((await service.get(ref)).effective.enabled).toBe(false);
    }
  });

  it("checks a first rule against the kind the address names", async () => {
    const { service, throughSales } = await twoAccountsInOneGroup([], false);
    const ref = { ...throughSales, chatId: "ou_ray" as ChatId };

    expect((await service.get(ref)).supportedFields).toEqual(["session.reset"]);
    await expect(
      service.update({ ref, set: { enabled: false }, clear: [], actor: { kind: "guardian" } }),
    ).rejects.toThrow('Unsupported conversation setting "enabled"');
  });

  it("starts the direct message an address names when a rule is set before anything is said", async () => {
    const { service, repository, wired, throughSales } = await twoAccountsInOneGroup([], false);
    const ref = { ...throughSales, chatId: "ou_ray" as ChatId };

    await service.update({
      ref,
      set: { session: { reset: { mode: "none" } } },
      clear: [],
      actor: { kind: "guardian" },
    });
    const ruled = repository.find("feishu", "ou_ray" as ChatId);
    expect(ruled).toMatchObject({ kind: "dm", placeName: null });
    // It starts a second before it was placed, so a first message heard in
    // that same second is one it has not seen.
    expect(ruled!.createdAt.getTime()).toBeLessThan(Math.floor(Date.now() / 1000) * 1000);

    // The first message from the other end finds the same speaker, in the
    // same direct message.
    const opened = await openSpeaker(
      testDb!.db,
      {
        channel: "feishu",
        threadId: "ou_ray",
        threadName: "Ray",
        threadType: "private",
        agentName: "main",
      },
      wired,
    );
    expect(opened.id).toBe(ruled!.id);
    // The address stood in for a name; the first message names the chat.
    expect(repository.find("feishu", "ou_ray" as ChatId)?.placeName).toBe("Ray");
    expect(repository.listKnown({ query: "Ray" }).map((row) => row.id)).toEqual([ruled!.id]);
    expect(repository.find("feishu", "ou_ray" as ChatId)).toMatchObject({
      kind: "dm",
      chatId: ruled!.chatId,
    });
    expect((await service.get(ref)).overrides).toEqual({ session: { reset: { mode: "none" } } });
  });

  it("reads a direct message a send opened as one, though asked for a group", async () => {
    const { service, wired, throughSales } = await twoAccountsInOneGroup([], false);
    // A send opened the direct message at an address that names no kind,
    // and stood no speaker in it.
    startChannelChat(wired, { channel: "feishu", threadId: "oc_ray", threadType: "private" });
    const ref = { ...throughSales, chatId: "oc_ray" as ChatId };

    expect((await service.get(ref)).supportedFields).toEqual(["session.reset"]);
    await expect(
      service.update({ ref, set: { enabled: false }, clear: [], actor: { kind: "guardian" } }),
    ).rejects.toThrow('Unsupported conversation setting "enabled"');
  });

  it("reads a direct message a send opened after its address was read as one", async () => {
    const { service, wired, throughSales } = await twoAccountsInOneGroup([], false);
    const ref = { ...throughSales, chatId: "oc_ray" as ChatId };
    // Read before Rome held anything there, so its kind is only a guess.
    await service.get(ref);
    startChannelChat(wired, { channel: "feishu", threadId: "oc_ray", threadType: "private" });

    expect((await service.get(ref)).supportedFields).toEqual(["session.reset"]);
    await expect(
      service.update({ ref, set: { enabled: false }, clear: [], actor: { kind: "guardian" } }),
    ).rejects.toThrow('Unsupported conversation setting "enabled"');
  });

  it("sets a rule in a direct message Rome holds with no speaker in it", async () => {
    const { service, repository, wired, throughSales } = await twoAccountsInOneGroup([], false);
    // A send opened the direct message with the party oc_ray names, and kept
    // no address for it.
    wired.chats.start(wired.adapters.chatAt("feishu", "oc_ray", "dm"), "dm", null);
    const ref = { ...throughSales, chatId: "oc_ray" as ChatId };

    await service.update({
      ref,
      set: { session: { reset: { mode: "none" } } },
      clear: [],
      actor: { kind: "guardian" },
    });

    expect(repository.find("feishu", "oc_ray" as ChatId)).toMatchObject({ kind: "dm" });
    expect((await service.get(ref)).overrides).toEqual({ session: { reset: { mode: "none" } } });
  });

  it("finds a chat its platform has not named by the name its speaker shows", async () => {
    const { service, repository, throughSales } = await twoAccountsInOneGroup([], false);
    await service.update({
      ref: { ...throughSales, chatId: "ou_ray" as ChatId },
      set: { session: { reset: { mode: "none" } } },
      clear: [],
      actor: { kind: "guardian" },
    });
    const ruled = repository.find("feishu", "ou_ray" as ChatId)!;

    expect(repository.listKnown({ query: "ou_ray" }).map((row) => row.id)).toEqual([ruled.id]);
  });

  it("places a speaker a rule starts before what its account already said there", async () => {
    const { service, repository, wired, throughSales } = await twoAccountsInOneGroup();
    // A send said something in the group before any rule, and opened no
    // session.
    const { chat } = startChannelChat(wired, { channel: "feishu", threadId: "oc_group" });
    await new MessageRepository(testDb!.db).send(
      {
        direction: "fromRome",
        place: placeIn(chat),
        saidBy: { account: { platform: "feishu", id: "ou_sales" }, agent: "main" },
        parts: [{ type: "text", content: "hello" }],
      },
      async () => ({ key: "sent-1" }),
    );
    // Said well before the rule, so a placement at now would miss it.
    const sentAt = new Date(Date.UTC(2026, 0, 1));
    testDb!.db.run(sql`UPDATE chat_messages SET said_at = ${sentAt.getTime() / 1000}`);

    await service.update({
      ref: throughSales,
      set: { enabled: false },
      clear: [],
      actor: { kind: "guardian" },
    });

    expect(repository.find("feishu", "oc_group" as ChatId)!.createdAt.getTime()).toBeLessThan(
      sentAt.getTime(),
    );
  });

  it("reads and writes one rule in a direct message its platform placed at another address", async () => {
    const { service, repository, wired, throughSales } = await twoAccountsInOneGroup([], false);
    const atPerson = { ...throughSales, chatId: "ou_ray" as ChatId };
    const atChat = { ...throughSales, chatId: "oc_ray" as ChatId };
    const reset = (mode: { mode: "none" } | { mode: "daily"; atHour: number }) =>
      service.update({
        ref: atPerson,
        set: { session: { reset: mode } },
        clear: [],
        actor: { kind: "guardian" },
      });
    await reset({ mode: "none" });
    const dm = repository.find("feishu", "ou_ray" as ChatId)!;
    // Ray's first message reaches the direct message at its chat id, where
    // the platform places it from then on, and opens a session there.
    const key = wired.adapters.keyOf(wired.chats.find(dm.chatId!)!.ref);
    new ChatAddresses(testDb!.db).bind(
      { platform: "feishu", id: "ou_sales" },
      key.externalId,
      "oc_ray",
    );
    const opened = await openSpeaker(
      testDb!.db,
      { channel: "feishu", threadId: "oc_ray", threadType: "private", agentName: "main" },
      wired,
    );
    expect(opened.id).not.toBe(dm.id);

    // The rule set before the message holds there.
    expect((await service.get(atChat)).overrides).toEqual({ session: { reset: { mode: "none" } } });

    await reset({ mode: "daily", atHour: 4 });
    for (const ref of [atPerson, atChat]) {
      expect((await service.get(ref)).overrides).toEqual({
        session: { reset: { mode: "daily", atHour: 4 } },
      });
    }
    expect(repository.find("feishu", "oc_ray" as ChatId)?.id).toBe(opened.id);
  });

  it("stores a rule set at a person's id where messages from them will arrive", async () => {
    const { service, wired, throughSales } = await twoAccountsInOneGroup([], false);
    // A send reached Ray's direct message at its chat id, with no session.
    const { key } = startChannelChat(wired, {
      channel: "feishu",
      threadId: "ou_ray",
      threadType: "private",
    });
    new ChatAddresses(testDb!.db).bind(
      { platform: "feishu", id: "ou_sales" },
      key.externalId,
      "oc_ray",
    );

    await service.update({
      ref: { ...throughSales, chatId: "ou_ray" as ChatId },
      set: { session: { reset: { mode: "none" } } },
      clear: [],
      actor: { kind: "guardian" },
    });
    // Ray's first reply arrives at the chat id and finds the rule's session.
    const opened = await openSpeaker(
      testDb!.db,
      { channel: "feishu", threadId: "oc_ray", threadType: "private", agentName: "main" },
      wired,
    );

    expect(opened.id).toBe("channel:feishu:oc_ray");
    expect((await service.get({ ...throughSales, chatId: "oc_ray" as ChatId })).overrides).toEqual({
      session: { reset: { mode: "none" } },
    });
  });

  it("names a chat a rule started by the first message the platform names", async () => {
    const { service, repository, wired, throughSales } = await twoAccountsInOneGroup([], false);
    await service.update({
      ref: { ...throughSales, chatId: "ou_ray" as ChatId },
      set: { session: { reset: { mode: "none" } } },
      clear: [],
      actor: { kind: "guardian" },
    });
    const ruled = repository.find("feishu", "ou_ray" as ChatId)!;

    // A message records its chat as the inbound recording does.
    const chat = wired.chats.find(ruled.chatId!)!;
    wired.chats.start(wired.adapters.keyOf(chat.ref), "dm", "Ray");

    expect(repository.find("feishu", "ou_ray" as ChatId)?.placeName).toBe("Ray");
    expect(repository.listKnown({ query: "Ray" }).map((row) => row.id)).toEqual([ruled.id]);
  });

  it("still reads a removed connection's rule once its channel lets go of its account", async () => {
    const { registry, service, paired, standIn, throughSales } = await twoAccountsInOneGroup();
    await standIn("feishu");
    await service.update({
      ref: throughSales,
      set: { enabled: false },
      clear: [],
      actor: { kind: "guardian" },
    });

    await registry.remove(throughSales.connectionId);
    // Removing the connection vacates its channel, which knows no account
    // from then on.
    paired.sales = null;

    expect((await service.get(throughSales)).effective.enabled).toBe(false);
  });

  it("names no chat after the address a direct message was first reached at", async () => {
    const { service, repository, wired, throughSales } = await twoAccountsInOneGroup([], false);
    const atPerson = { ...throughSales, chatId: "ou_ray" as ChatId };
    const reset = (policy: { mode: "none" } | { mode: "daily"; atHour: number }) =>
      service.update({
        ref: atPerson,
        set: { session: { reset: policy } },
        clear: [],
        actor: { kind: "guardian" },
      });
    await reset({ mode: "none" });
    const ruled = repository.find("feishu", "ou_ray" as ChatId)!;
    // A send places the direct message at its chat id before Ray names it.
    const chat = wired.chats.find(ruled.chatId!)!;
    new ChatAddresses(testDb!.db).bind(
      { platform: "feishu", id: "ou_sales" },
      wired.adapters.keyOf(chat.ref).externalId,
      "oc_ray",
    );

    await reset({ mode: "daily", atHour: 4 });
    expect(wired.chats.find(ruled.chatId!)!.name).toBeNull();

    wired.chats.start(wired.adapters.keyOf(chat.ref), "dm", "Ray");
    expect(wired.chats.find(ruled.chatId!)!.name).toBe("Ray");
  });

  it("names no chat after the placeholder a session opened without a name took", async () => {
    const { service, repository, wired, throughSales } = await twoAccountsInOneGroup([], false);
    const ref = { ...throughSales, chatId: "ou_ray" as ChatId };
    const input = {
      channel: "feishu",
      threadId: "ou_ray",
      threadType: "private" as const,
      agentName: "main",
    };
    await openSpeaker(testDb!.db, input, wired);

    await service.update({
      ref,
      set: { session: { reset: { mode: "none" } } },
      clear: [],
      actor: { kind: "guardian" },
    });
    expect(repository.find("feishu", "ou_ray" as ChatId)?.placeName).toBeNull();

    await openSpeaker(testDb!.db, { ...input, threadName: "Ray" }, wired);
    expect(repository.find("feishu", "ou_ray" as ChatId)?.placeName).toBe("Ray");
  });

  it("moves the speaker to the account its channel is paired as now when a rule is set", async () => {
    const { service, repository, wired, paired, throughSales } = await twoAccountsInOneGroup();
    const ref = { ...throughSales, chatId: "ou_ray" as ChatId };
    await openSpeaker(
      testDb!.db,
      { channel: "feishu", threadId: "ou_ray", threadType: "private", agentName: "main" },
      wired,
    );
    const before = repository.find("feishu", "ou_ray" as ChatId)!;

    paired.sales = "ou_sales_again";
    await service.update({
      ref,
      set: { session: { reset: { mode: "none" } } },
      clear: [],
      actor: { kind: "guardian" },
    });

    const after = repository.find("feishu", "ou_ray" as ChatId);
    expect(after).toMatchObject({ id: before.id, accountId: "ou_sales_again", kind: "dm" });
    expect(after!.chatId).not.toBe(before.chatId);
    expect((await service.get(ref)).overrides).toEqual({ session: { reset: { mode: "none" } } });
  });

  it("sets the rule on the speaker a reconnected channel speaks through", async () => {
    const { service, repository, wired, paired, standIn, throughSales } =
      await twoAccountsInOneGroup(["pm-assistant"]);
    await standIn("feishu");
    const retired = repository.find("feishu", "oc_group" as ChatId)!;
    testDb!.db.run(sql`UPDATE rome_sessions SET created_at = 1 WHERE id = ${retired.id}`);
    // Reconnected, the account speaks through a channel of a new name, and
    // its first message there opens a session of its own in the same chat.
    paired.salesChannel = "feishu-3";
    const active = await openSpeaker(
      testDb!.db,
      { channel: "feishu-3", threadId: "oc_group", agentName: "main" },
      wired,
    );

    await service.update({
      ref: throughSales,
      set: { routing: { agentName: "pm-assistant" } },
      clear: [],
      actor: { kind: "guardian" },
    });

    expect(repository.find("feishu-3", "oc_group" as ChatId)).toMatchObject({
      id: active.id,
      agentName: "pm-assistant",
    });
  });

  it("keeps a rule set after a reconnect for the first message through the new channel", async () => {
    const { service, repository, wired, paired, standIn, throughSales } =
      await twoAccountsInOneGroup(["pm-assistant"]);
    await standIn("feishu");
    paired.salesChannel = "feishu-3";

    await service.update({
      ref: throughSales,
      set: { routing: { agentName: "pm-assistant" } },
      clear: [],
      actor: { kind: "guardian" },
    });
    const opened = await openSpeaker(
      testDb!.db,
      { channel: "feishu-3", threadId: "oc_group", agentName: "main" },
      wired,
    );

    expect(opened.agentName).toBe("pm-assistant");
    expect(repository.find("feishu-3", "oc_group" as ChatId)?.id).toBe(opened.id);
  });

  it("finds a speaker by the name of its chat, whatever its session is titled", async () => {
    const { repository, standIn } = await twoAccountsInOneGroup();
    await standIn("feishu");
    await standIn("feishu-2");
    const [sales, support] = ["feishu", "feishu-2"].map(
      (channel) => repository.find(channel, "oc_group" as ChatId)!,
    );
    {
      // The chat is named Launch; one session's title is something else.
      testDb!.db.run(sql`UPDATE chats SET name = 'Launch' WHERE id = ${sales!.chatId}`);
      testDb!.db.run(sql`UPDATE rome_sessions SET name = 'Renamed' WHERE id = ${support!.id}`);
    }

    expect(
      repository
        .listKnown({ query: "Launch" })
        .map((row) => row.id)
        .sort(),
    ).toEqual([sales!.id, support!.id].sort());
    expect(repository.listKnown({ query: "Renamed" })).toEqual([]);
  });

  it("paginates beyond a bounded live directory first page", async () => {
    testDb = createTestDb();
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
    });
    registry.register(
      directoryDescriptor("discord", (connectionId) =>
        Array.from({ length: 5 }, (_, index) => ({
          ref: {
            connectionId,
            chatId: `channel-${index}` as ChatId,
          },
          connectionKind: "discord",
          service: "discord",
          kind: "channel" as const,
          displayName: `channel-${index}`,
        })),
      ),
    );
    await connectLive(registry, "discord");
    const service = new ChatSettingsService({
      repository: new ChatSettingsRepository(testDb.db, testChatsWiring(testDb.db)),
      connections: registry,
      channelOf: kindChannelOf,
      channels: channelsOver(registry),
      listAgents: () => [],
      onChanged: () => {},
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
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
    });
    registry.register(directoryDescriptor("discord", () => []));
    const discord = await connectLive(registry, "discord");
    const repository = new ChatSettingsRepository(testDb.db, testChatsWiring(testDb.db));
    const descriptors = Array.from({ length: 5 }, (_, index) => ({
      ref: {
        connectionId: discord.id,
        chatId: `channel-${index}` as ChatId,
      },
      connectionKind: "discord",
      service: "discord",
      kind: "channel" as const,
      displayName: `channel-${index}`,
    }));
    for (const descriptor of descriptors) {
      repository.mutate(descriptor, descriptor.connectionKind, { settings: null, agentName: null });
    }
    repository.mutate(
      {
        ref: { connectionId: discord.id, chatId: "topic-1" as ChatId },
        connectionKind: "discord",
        service: "discord",
        kind: "topic",
        displayName: "topic-1",
        parent: descriptors[0]!.ref,
      },
      "discord",
      { settings: null, agentName: null },
    );
    const find = rs.spyOn(repository, "find");
    const listKnown = rs.spyOn(repository, "listKnown");
    const service = new ChatSettingsService({
      repository,
      connections: registry,
      channelOf: kindChannelOf,
      channels: channelsOver(registry),
      listAgents: () => [],
      onChanged: () => {},
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

  it("keeps guardian chats out of conversation settings", async () => {
    testDb = createTestDb();
    await new ChatsWebChatRepository(testDb.db).createSession("chat-1", "Chat");
    const repository = new ChatSettingsRepository(testDb.db, testChatsWiring(testDb.db));

    expect(repository.find("webchat", "chat-1" as ChatId)).toBeNull();
    expect(() =>
      repository.mutate(
        {
          ref: { connectionId: "webchat", chatId: "chat-2" as ChatId },
          connectionKind: "webchat",
          service: "webchat",
          kind: "channel",
          displayName: "chat-2",
        },
        "webchat",
        { settings: null, agentName: undefined },
      ),
    ).toThrow("Webchat chats have no conversation settings");
    expect(await new ChatsWebChatRepository(testDb.db).getSession("chat-2")).toBeNull();
  });
});
