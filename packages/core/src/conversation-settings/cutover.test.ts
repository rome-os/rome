import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { connections, romeSessions } from "../db/schema/system.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { channelConversationId } from "../db/repositories/webchat.js";
import type { ConversationSettingsService } from "./service.js";
import { cutoverConversationSettings } from "./cutover.js";

describe("conversation settings startup cutover", () => {
  let testDb: TestDb | undefined;
  afterEach(() => testDb?.close());

  function insertLegacySession(input: {
    id: string;
    service: string;
    threadId: string;
    parentSessionId?: string;
    threadType?: "channel" | "group" | "private" | "topic";
  }) {
    const now = new Date("2026-08-03T00:00:00.000Z");
    testDb!.db
      .insert(romeSessions)
      .values({
        id: input.id,
        name: input.threadId,
        personaId: null,
        projectName: "default",
        projectPath: null,
        largeModelSelection: null,
        agentName: null,
        type: "channel",
        sourceChannel: input.service,
        sourceThreadId: input.threadId,
        sourceThreadName: input.threadId,
        sourceThreadType: input.threadType ?? (input.parentSessionId ? "topic" : "channel"),
        channelSettings: null,
        parentSessionId: input.parentSessionId ?? null,
        createdAt: now,
        activityAt: now,
        lastSeenActivityAt: null,
      })
      .run();
  }

  it("atomically migrates provider maps and writes the completion marker", async () => {
    testDb = createTestDb();
    const settings = new SettingsRepository(testDb.db);
    const createdAt = new Date("2026-08-03T00:00:00.000Z");
    testDb.db
      .insert(connections)
      .values([
        { id: "discord-1", service: "discord", label: "Discord", createdAt },
        { id: "feishu-1", service: "feishu", label: "Feishu", createdAt },
      ])
      .run();
    insertLegacySession({ id: "channel:discord:parent", service: "discord", threadId: "parent" });
    insertLegacySession({
      id: "channel:discord:child",
      service: "discord",
      threadId: "child",
      parentSessionId: "channel:discord:parent",
    });
    insertLegacySession({
      id: "channel:discord:dm",
      service: "discord",
      threadId: "dm",
      threadType: "private",
    });
    await settings.set("discord.channels", {
      parent: {
        channelName: "general",
        requireMention: false,
        allowBots: "all",
        agentName: "pm-assistant",
        updatedAt: "2026-08-02T12:00:00.000Z",
        updatedBy: "Ray",
      },
      child: {
        channelName: "launch thread",
        mode: "ignore",
        agentName: "pm-assistant",
      },
      dm: { mode: "ignore" },
    });
    await settings.set("feishu.channels", {
      oc_group: { chatName: "Launch", mode: "ignore", autoThread: false },
    });
    const observe = rs.fn();

    cutoverConversationSettings({
      db: testDb.db,
      service: { observe } as unknown as ConversationSettingsService,
      listAgents: () => ["pm-assistant"],
    });

    const parentId = channelConversationId("discord", "parent");
    const childId = channelConversationId("discord", "child");
    const dmId = channelConversationId("discord", "dm");
    const parent = testDb.db.select().from(romeSessions).where(eq(romeSessions.id, parentId)).get();
    const child = testDb.db.select().from(romeSessions).where(eq(romeSessions.id, childId)).get();
    const dm = testDb.db.select().from(romeSessions).where(eq(romeSessions.id, dmId)).get();
    expect(parent).toMatchObject({
      sourceThreadName: "general",
      agentName: "pm-assistant",
      channelSettings: {
        schemaVersion: 1,
        overrides: {
          activation: { mode: "all", botMessages: "all" },
        },
        updatedAt: "2026-08-02T12:00:00.000Z",
        updatedBy: { kind: "system", id: "rfc-060-cutover", displayName: "Ray" },
      },
    });
    expect(child).toMatchObject({
      parentSessionId: parentId,
      agentName: null,
      channelSettings: null,
    });
    expect(dm).toMatchObject({
      sourceThreadType: "private",
      agentName: null,
      channelSettings: null,
    });
    expect(await settings.get("discord.channels")).toBeNull();
    expect(await settings.get("feishu.channels")).toBeNull();
    expect(await settings.get("conversation_settings_cutover_v1")).toMatchObject({
      completedAt: expect.any(String),
    });
    expect(observe).toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { connectionId: "discord-1", conversationId: "child" },
        parent: { connectionId: "discord-1", conversationId: "parent" },
      }),
    );
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { connectionId: "discord-1", conversationId: "dm" },
        kind: "dm",
      }),
    );
  });

  it("completes an empty legacy map without a live connection", async () => {
    testDb = createTestDb();
    const settings = new SettingsRepository(testDb.db);
    await settings.set("discord.channels", {});
    const observe = rs.fn();

    cutoverConversationSettings({
      db: testDb.db,
      service: { observe } as unknown as ConversationSettingsService,
      listAgents: () => [],
    });

    expect(await settings.get("discord.channels")).toBeNull();
    expect(await settings.get("conversation_settings_cutover_v1")).toMatchObject({
      completedAt: expect.any(String),
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("persists orphaned legacy settings without observing a connection", async () => {
    testDb = createTestDb();
    const settings = new SettingsRepository(testDb.db);
    await settings.set("discord.channels", {
      general: { channelName: "general", requireMention: false },
    });
    const observe = rs.fn();

    cutoverConversationSettings({
      db: testDb.db,
      service: { observe } as unknown as ConversationSettingsService,
      listAgents: () => [],
    });

    expect(
      testDb.db
        .select()
        .from(romeSessions)
        .where(eq(romeSessions.id, channelConversationId("discord", "general")))
        .get(),
    ).toMatchObject({
      sourceThreadName: "general",
      channelSettings: {
        schemaVersion: 1,
        overrides: { activation: { mode: "all" } },
      },
    });
    expect(await settings.get("discord.channels")).toBeNull();
    expect(observe).not.toHaveBeenCalled();
  });

  it("rolls every write back when migrated state is invalid", async () => {
    testDb = createTestDb();
    const settings = new SettingsRepository(testDb.db);
    testDb.db
      .insert(connections)
      .values({
        id: "discord-1",
        service: "discord",
        label: "Discord",
        createdAt: new Date(),
      })
      .run();
    insertLegacySession({ id: "channel:discord:general", service: "discord", threadId: "general" });
    await settings.set("discord.channels", {
      general: { agentName: "missing-agent" },
    });

    expect(() =>
      cutoverConversationSettings({
        db: testDb!.db,
        service: { observe() {} } as unknown as ConversationSettingsService,
        listAgents: () => [],
      }),
    ).toThrow('Agent "missing-agent" is not loaded');

    expect(
      testDb.db
        .select()
        .from(romeSessions)
        .where(eq(romeSessions.id, "channel:discord:general"))
        .get()?.channelSettings,
    ).toBeNull();
    expect(await settings.get("discord.channels")).not.toBeNull();
    expect(await settings.get("conversation_settings_cutover_v1")).toBeNull();
  });
});
