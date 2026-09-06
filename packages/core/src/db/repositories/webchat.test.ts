import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import type { DrizzleDb } from "../index.js";
import { romeAgentMessages, romeSessions, romeAgentTraceBlocks } from "../schema.js";
import { WebChatRepository, channelConversationId, validateTurnRecapAudioUrl } from "./webchat.js";

// Records which statement entry points (`select`, `insert`, `update`, `delete`,
// `transaction`) a repository reaches for on the connection itself, so a test
// can assert a write goes through one transaction rather than as separate
// autocommit statements.
function trackStatements(db: DrizzleDb): { db: DrizzleDb; statements: string[] } {
  const statements: string[] = [];
  const tracked = new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (
        prop === "select" ||
        prop === "insert" ||
        prop === "update" ||
        prop === "delete" ||
        prop === "transaction"
      ) {
        statements.push(prop);
      }
      return value.bind(target);
    },
  }) as DrizzleDb;
  return { db: tracked, statements };
}

describe("WebChatRepository", () => {
  let testDb: TestDb;
  let repo: WebChatRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new WebChatRepository(testDb.db);
  });

  afterEach(() => {
    rs.useRealTimers();
    testDb.close();
  });

  it("persists input identity, consumption binding, and uncertain recovery without replay", async () => {
    await repo.createSession("input-session", "Inputs");
    expect(await repo.recordUserInput("first", "input-session", "[]")).toBe(true);
    expect(await repo.recordUserInput("first", "input-session", "[]")).toBe(false);
    await repo.recordUserInput("second", "input-session", "[]");
    await repo.updateUserInput("input-session", {
      type: "input_status",
      inputId: "first",
      turnId: "turn-a",
      state: "consumed",
    });
    await repo.updateUserInput("input-session", {
      type: "input_status",
      inputId: "second",
      turnId: "turn-a",
      state: "accepted",
    });
    await repo.recoverInterruptedInputs();
    expect(await repo.getUserInput("input-session", "first")).toEqual({
      turnId: "turn-a",
      inputState: "consumed",
    });
    expect(await repo.getUserInput("input-session", "second")).toEqual({
      turnId: "turn-a",
      inputState: "unknown",
    });
    await repo.updateUserInput("input-session", {
      type: "input_status",
      inputId: "second",
      turnId: "turn-b",
      state: "consumed",
    });
    expect(
      (await repo.getMessages("input-session")).map(({ id, turnId }) => ({ id, turnId })),
    ).toEqual([
      { id: "first", turnId: "turn-a" },
      { id: "second", turnId: "turn-b" },
    ]);
  });

  it("lists sessions with message counts and project names", async () => {
    await repo.createSession("sess-1", "Chat A", "guardian-1");
    await repo.createSession("sess-2", "Chat B");
    await repo.updateSessionProject("sess-1", "alpha");
    await repo.addMessage("msg-1", "sess-1", "user", "[]");

    const sessions = await repo.listSessions();

    expect(sessions).toHaveLength(2);
    const first = sessions.find((session) => session.id === "sess-1");
    expect(first).toMatchObject({
      id: "sess-1",
      personaId: "guardian-1",
      projectName: "alpha",
      projectPath: "alpha",
      messageCount: 1,
    });

    const second = sessions.find((session) => session.id === "sess-2");
    expect(second).toMatchObject({
      id: "sess-2",
      projectName: "default",
      projectPath: "default",
      messageCount: 0,
    });
  });

  describe("channel conversation continuity", () => {
    const textContent = (text: string) => JSON.stringify([{ type: "text", content: text }]);

    it("keeps one thread session while refreshing its routing from the parent", async () => {
      const first = await repo.ensureChannelConversation({
        channel: "discord",
        threadId: "thread-1",
        parentThreadId: "channel-1",
        threadName: "Sprint planning",
        threadType: "group",
        agentName: "main",
      });
      await testDb.db
        .update(romeSessions)
        .set({ agentName: "release-agent" })
        .where(eq(romeSessions.id, channelConversationId("discord", "channel-1")));
      const second = await repo.ensureChannelConversation({
        channel: "discord",
        threadId: "thread-1",
        parentThreadId: "channel-1",
        agentName: "release-agent",
      });

      expect(first).toEqual({
        id: channelConversationId("discord", "thread-1"),
        agentName: null,
      });
      expect(second).toEqual({ ...first, agentName: "release-agent" });

      const rows = await testDb.db.select().from(romeSessions).where(eq(romeSessions.id, first.id));
      expect(rows[0]).toMatchObject({
        parentSessionId: channelConversationId("discord", "channel-1"),
        sourceChannel: "discord",
        sourceThreadId: "thread-1",
        agentName: "release-agent",
        type: "channel",
      });
      const parentRows = await testDb.db
        .select()
        .from(romeSessions)
        .where(eq(romeSessions.id, channelConversationId("discord", "channel-1")));
      expect(parentRows[0]?.agentName).toBe("release-agent");
    });

    it("deduplicates webhook retries within a conversation but not across conversations", async () => {
      const first = await repo.ensureChannelConversation({
        channel: "telegram",
        threadId: "chat-1",
        agentName: "main",
      });
      const second = await repo.ensureChannelConversation({
        channel: "telegram",
        threadId: "chat-2",
        agentName: "main",
      });
      const message = {
        role: "user" as const,
        content: textContent("hello"),
        platformMessageId: "42",
      };

      await expect(
        repo.addConversationMessage({ ...message, sessionId: first.id }),
      ).resolves.toEqual({ inserted: true });
      await expect(
        repo.addConversationMessage({ ...message, sessionId: first.id }),
      ).resolves.toEqual({ inserted: false });
      await expect(
        repo.addConversationMessage({ ...message, sessionId: second.id }),
      ).resolves.toEqual({ inserted: true });
    });

    describe("addConversationMessage atomicity", () => {
      it("writes the message and the session activity update through one transaction", async () => {
        const conversation = await repo.ensureChannelConversation({
          channel: "telegram",
          threadId: "atomic-single-transaction",
          agentName: "main",
        });
        const { db, statements } = trackStatements(testDb.db);
        const trackedRepo = new WebChatRepository(db);

        await expect(
          trackedRepo.addConversationMessage({
            sessionId: conversation.id,
            role: "user",
            content: textContent("hello"),
            platformMessageId: "atomic-1",
            createdAt: new Date("2026-08-03T09:00:00.000Z"),
          }),
        ).resolves.toEqual({ inserted: true });

        expect(statements).toEqual(["transaction"]);
      });

      it("returns { inserted: false } for a duplicate platform message id without advancing session activity", async () => {
        const conversation = await repo.ensureChannelConversation({
          channel: "telegram",
          threadId: "atomic-duplicate",
          agentName: "main",
        });
        const message = {
          sessionId: conversation.id,
          role: "user" as const,
          content: textContent("hello"),
          platformMessageId: "atomic-duplicate-1",
        };
        await expect(
          repo.addConversationMessage({
            ...message,
            createdAt: new Date("2026-08-03T09:00:00.000Z"),
          }),
        ).resolves.toEqual({ inserted: true });
        const [afterInsert] = await testDb.db
          .select()
          .from(romeSessions)
          .where(eq(romeSessions.id, conversation.id));

        await expect(
          repo.addConversationMessage({
            ...message,
            content: textContent("hello again"),
            createdAt: new Date("2026-08-03T10:00:00.000Z"),
          }),
        ).resolves.toEqual({ inserted: false });

        const [afterDuplicate] = await testDb.db
          .select()
          .from(romeSessions)
          .where(eq(romeSessions.id, conversation.id));
        expect(afterDuplicate.activityAt.getTime()).toBe(afterInsert.activityAt.getTime());
        const rows = await testDb.db
          .select({ content: romeAgentMessages.content })
          .from(romeAgentMessages)
          .where(eq(romeAgentMessages.sessionId, conversation.id));
        expect(rows).toEqual([{ content: textContent("hello") }]);
      });

      it("leaves no message row behind when the session activity update fails", async () => {
        const conversation = await repo.ensureChannelConversation({
          channel: "telegram",
          threadId: "atomic-rollback",
          agentName: "main",
        });
        const [before] = await testDb.db
          .select()
          .from(romeSessions)
          .where(eq(romeSessions.id, conversation.id));
        // Fail the activity write at the database, the way a constraint or a
        // disk error would, so the assertion is about the rollback and not
        // about a stubbed repository method.
        testDb.db.run(sql`
          CREATE TRIGGER reject_session_activity_update
          BEFORE UPDATE OF activity_at ON rome_sessions
          BEGIN
            SELECT RAISE(ABORT, 'session activity update failed');
          END;
        `);

        await expect(
          repo.addConversationMessage({
            sessionId: conversation.id,
            role: "user",
            content: textContent("hello"),
            platformMessageId: "atomic-rollback-1",
            createdAt: new Date("2026-08-03T09:00:00.000Z"),
          }),
        ).rejects.toThrow(/session activity update failed/);

        const rows = await testDb.db
          .select()
          .from(romeAgentMessages)
          .where(eq(romeAgentMessages.sessionId, conversation.id));
        expect(rows).toEqual([]);
        const [after] = await testDb.db
          .select()
          .from(romeSessions)
          .where(eq(romeSessions.id, conversation.id));
        expect(after.activityAt.getTime()).toBe(before.activityAt.getTime());
      });
    });

    it("loads pending notifications and the exact replied-to message, then marks only notifications injected", async () => {
      const conversation = await repo.ensureChannelConversation({
        channel: "discord",
        threadId: "thread-context",
        agentName: "main",
      });
      await repo.addConversationMessage({
        sessionId: conversation.id,
        role: "user",
        content: textContent("the original question"),
        platformMessageId: "original",
        senderName: "Alice",
        createdAt: new Date("2026-08-03T08:00:00.000Z"),
      });
      await repo.addConversationMessage({
        sessionId: conversation.id,
        role: "notification",
        content: textContent("first ambient message"),
        platformMessageId: "ambient-1",
        senderName: "Bob",
        createdAt: new Date("2026-08-03T08:01:00.000Z"),
      });
      await repo.addConversationMessage({
        sessionId: conversation.id,
        role: "notification",
        content: textContent("second ambient message"),
        platformMessageId: "ambient-2",
        senderName: "Carol",
        createdAt: new Date("2026-08-03T08:02:00.000Z"),
      });

      const context = await repo.loadConversationContext(conversation.id, "original");
      expect(context.notifications.map((message) => message.content)).toEqual([
        textContent("first ambient message"),
        textContent("second ambient message"),
      ]);
      expect(context.pendingNotificationIds).toHaveLength(2);
      expect(context.omittedNotificationCount).toBe(0);
      expect(context.repliedTo).toMatchObject({
        content: textContent("the original question"),
        senderName: "Alice",
      });

      await repo.markConversationContextInjected(context.pendingNotificationIds, "turn-1");

      const afterInjection = await repo.loadConversationContext(conversation.id, "original");
      expect(afterInjection.notifications).toEqual([]);
      expect(afterInjection.pendingNotificationIds).toEqual([]);
      expect(afterInjection.omittedNotificationCount).toBe(0);
      expect(afterInjection.repliedTo?.content).toBe(textContent("the original question"));
    });

    it("projects the latest 20 notifications and consumes the full pending snapshot", async () => {
      const conversation = await repo.ensureChannelConversation({
        channel: "discord",
        threadId: "bounded-context",
        agentName: "main",
      });
      for (let index = 0; index < 23; index += 1) {
        await repo.addConversationMessage({
          sessionId: conversation.id,
          role: "notification",
          content: textContent(`ambient ${index + 1}`),
          platformMessageId: `ambient-${index + 1}`,
          senderName: "Participant",
          createdAt: new Date(Date.UTC(2026, 7, 3, 8, index)),
        });
      }

      const context = await repo.loadConversationContext(conversation.id);
      expect(context.notifications).toHaveLength(20);
      expect(context.notifications[0]?.content).toBe(textContent("ambient 4"));
      expect(context.notifications.at(-1)?.content).toBe(textContent("ambient 23"));
      expect(context.pendingNotificationIds).toHaveLength(23);
      expect(context.omittedNotificationCount).toBe(3);

      await repo.markConversationContextInjected(context.pendingNotificationIds, "turn-bounded");

      await expect(repo.loadConversationContext(conversation.id)).resolves.toEqual({
        notifications: [],
        pendingNotificationIds: [],
        omittedNotificationCount: 0,
        repliedTo: null,
      });
    });

    it("resolves a native thread reply target from its parent conversation", async () => {
      const parent = await repo.ensureChannelConversation({
        channel: "discord",
        threadId: "parent-channel",
        agentName: "main",
      });
      const child = await repo.ensureChannelConversation({
        channel: "discord",
        threadId: "child-thread",
        parentThreadId: "parent-channel",
        agentName: "main",
      });
      await repo.addConversationMessage({
        sessionId: parent.id,
        role: "user",
        content: textContent("thread starter"),
        platformMessageId: "starter-message",
        senderName: "Alice",
      });

      await expect(
        repo.loadConversationContext(child.id, "starter-message"),
      ).resolves.toMatchObject({
        notifications: [],
        repliedTo: {
          content: textContent("thread starter"),
          senderName: "Alice",
        },
      });
    });

    it("injects the parent message referenced by a pending Rome notification only once", async () => {
      const parent = await repo.ensureChannelConversation({
        channel: "discord",
        threadId: "parent-channel-context",
        agentName: "main",
      });
      const child = await repo.ensureChannelConversation({
        channel: "discord",
        threadId: "child-thread-context",
        parentThreadId: "parent-channel-context",
        agentName: "main",
      });
      await repo.addConversationMessage({
        sessionId: parent.id,
        role: "user",
        content: textContent("thread starter question"),
        platformMessageId: "thread-starter-question",
        senderName: "Alice",
      });
      await repo.recordOutboundConversationMessage({
        sessionId: child.id,
        content: textContent("Rome's first thread reply"),
        platformMessageId: "first-thread-reply",
        senderId: "rome",
        senderName: "Rome",
        replyToPlatformMessageId: "thread-starter-question",
        knownToProvider: false,
      });

      const context = await repo.loadConversationContext(child.id);
      expect(context.notifications.map((message) => message.content)).toEqual([
        textContent("thread starter question"),
        textContent("Rome's first thread reply"),
      ]);
      expect(context.pendingNotificationIds).toHaveLength(1);
      expect(context.omittedNotificationCount).toBe(0);
      expect(context.repliedTo).toBeNull();

      await repo.markConversationContextInjected(context.pendingNotificationIds, "child-turn-1");

      await expect(repo.loadConversationContext(child.id)).resolves.toEqual({
        notifications: [],
        pendingNotificationIds: [],
        omittedNotificationCount: 0,
        repliedTo: null,
      });
    });

    it("keeps the pending Rome notification when its referenced parent message is missing", async () => {
      const child = await repo.ensureChannelConversation({
        channel: "discord",
        threadId: "child-thread-missing-root",
        parentThreadId: "parent-channel-missing-root",
        agentName: "main",
      });
      await repo.recordOutboundConversationMessage({
        sessionId: child.id,
        content: textContent("Rome reply without a stored root"),
        platformMessageId: "orphaned-thread-reply",
        senderId: "rome",
        senderName: "Rome",
        replyToPlatformMessageId: "missing-thread-starter",
        knownToProvider: false,
      });

      const context = await repo.loadConversationContext(child.id);
      expect(context.notifications.map((message) => message.content)).toEqual([
        textContent("Rome reply without a stored root"),
      ]);
      expect(context.pendingNotificationIds).toHaveLength(1);
      expect(context.omittedNotificationCount).toBe(0);
      expect(context.repliedTo).toBeNull();
    });

    it("attaches delivery metadata to provider-known output and stores out-of-band output as notification", async () => {
      const conversation = await repo.ensureChannelConversation({
        channel: "telegram",
        threadId: "chat-output",
        agentName: "main",
      });
      const providerContent = textContent("provider answer");
      await repo.addMessage(
        "provider-row",
        conversation.id,
        "assistant",
        providerContent,
        "turn-provider",
      );

      await repo.recordOutboundConversationMessage({
        sessionId: conversation.id,
        content: providerContent,
        platformMessageId: "delivered-provider",
        senderName: "Rome",
        turnId: "turn-provider",
        knownToProvider: true,
      });
      await repo.recordOutboundConversationMessage({
        sessionId: conversation.id,
        content: textContent("background update"),
        platformMessageId: "delivered-background",
        senderName: "Rome",
        knownToProvider: false,
      });

      const rows = await testDb.db
        .select()
        .from(romeAgentMessages)
        .where(eq(romeAgentMessages.sessionId, conversation.id));
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.platformMessageId === "delivered-provider")).toMatchObject({
        id: "provider-row",
        role: "assistant",
        turnId: "turn-provider",
      });
      expect(rows.find((row) => row.platformMessageId === "delivered-background")).toMatchObject({
        role: "notification",
        contextInjectedTurnId: null,
      });
    });
  });

  describe("searchSessionMessages", () => {
    const textMessage = (text: string) => JSON.stringify([{ type: "text", content: text }]);

    it("matches user and assistant transcript text, one hit per session", async () => {
      await repo.createSession("sess-a", "Alpha");
      await repo.createSession("sess-b", "Beta");
      await repo.addMessage("m1", "sess-a", "user", textMessage("Deploy the staging server"));
      await repo.addMessage("m2", "sess-a", "assistant", textMessage("Staging deploy scheduled"));
      await repo.addMessage("m3", "sess-b", "user", textMessage("Unrelated grocery list"));

      const results = await repo.searchSessionMessages("staging deploy");

      expect(results).toHaveLength(1);
      expect(results[0].session.id).toBe("sess-a");
      // Most recent matching message in the session wins.
      expect(results[0].message).toMatchObject({ id: "m2", role: "assistant" });
      expect(results[0].message.snippet).toContain("Staging deploy scheduled");
    });

    it("never matches trace rows, non-text blocks, or JSON structure", async () => {
      await repo.createSession("sess-a", "Alpha");
      await repo.addMessage("m1", "sess-a", "trace", textMessage("staging secrets in trace"));
      await repo.addMessage(
        "m2",
        "sess-a",
        "assistant",
        JSON.stringify([{ type: "tool_use", content: "staging", input: { cmd: "staging" } }]),
      );

      // "content" appears as a JSON key in every stored message; text-only
      // extraction must keep it from matching.
      expect(await repo.searchSessionMessages("staging")).toEqual([]);
      expect(await repo.searchSessionMessages("content")).toEqual([]);
    });

    it("ellipsizes long matches into a snippet around the hit", async () => {
      await repo.createSession("sess-a", "Alpha");
      const padding = "lorem ipsum ".repeat(40);
      await repo.addMessage(
        "m1",
        "sess-a",
        "user",
        textMessage(`${padding} the needle sits here ${padding}`),
      );

      const results = await repo.searchSessionMessages("needle");

      expect(results).toHaveLength(1);
      const snippet = results[0].message.snippet;
      expect(snippet).toContain("needle");
      expect(snippet.startsWith("…")).toBe(true);
      expect(snippet.endsWith("…")).toBe(true);
      expect(snippet.length).toBeLessThan(200);
    });

    it("requires all terms in the same message and honors the session limit", async () => {
      await repo.createSession("sess-a", "Alpha");
      await repo.createSession("sess-b", "Beta");
      // Terms split across two messages of sess-a: no match.
      await repo.addMessage("m1", "sess-a", "user", textMessage("alpha only here"));
      await repo.addMessage("m2", "sess-a", "assistant", textMessage("omega only here"));
      await repo.addMessage("m3", "sess-b", "user", textMessage("alpha and omega together"));

      expect(await repo.searchSessionMessages("alpha omega")).toMatchObject([
        { session: { id: "sess-b" } },
      ]);

      const limited = await repo.searchSessionMessages("only", { sessionLimit: 1 });
      expect(limited).toHaveLength(1);
    });
  });

  it("lists sessions filtered by project path in the database", async () => {
    await repo.createSession("sess-alpha", "Chat Alpha", undefined, "alpha", null, "alpha");
    await repo.createSession(
      "sess-alpha-nested",
      "Chat Nested",
      undefined,
      "nested",
      null,
      "alpha/nested",
    );
    await repo.createSession("sess-legacy", "Chat Legacy", undefined, "legacy", null, null);
    await repo.createSession("sess-other", "Chat Other", undefined, "other", null, "other");
    await repo.addMessage("msg-alpha", "sess-alpha", "user", "[]");
    await repo.addMessage("msg-legacy", "sess-legacy", "user", "[]");

    const alphaSessions = await repo.listSessionsByProjectPath("alpha");
    const nestedSessions = await repo.listSessionsByProjectPath("alpha/nested");
    const nullPathSessions = await repo.listSessionsByProjectPath("legacy");

    expect(alphaSessions.sessions.map((session) => session.id)).toEqual(["sess-alpha"]);
    expect(nestedSessions.sessions.map((session) => session.id)).toEqual(["sess-alpha-nested"]);
    expect(alphaSessions.sessions[0]).toMatchObject({
      id: "sess-alpha",
      messageCount: 1,
      projectName: "alpha",
      projectPath: "alpha",
    });
    expect(nullPathSessions).toMatchObject({ nextCursor: null, sessions: [], total: 0 });
  });

  it("lists distinct session project paths", async () => {
    await repo.createSession("sess-alpha", "Chat Alpha", undefined, "alpha", null, "alpha");
    await repo.createSession(
      "sess-alpha-nested",
      "Chat Nested",
      undefined,
      "nested",
      null,
      "alpha/nested",
    );
    await repo.createSession("sess-alpha-2", "Chat Alpha 2", undefined, "alpha", null, "alpha");
    await repo.createSession("sess-legacy", "Chat Legacy", undefined, "legacy", null, null);

    await expect(repo.listProjectPaths()).resolves.toEqual(["default", "alpha", "alpha/nested"]);
  });

  it("stores first-class projects independently from sessions", async () => {
    const project = await repo.createProject("Alpha", "alpha");

    await expect(repo.getProjectByPath("alpha")).resolves.toMatchObject({
      id: project.id,
      name: "Alpha",
      path: "alpha",
      archivedAt: null,
    });
    await expect(repo.listProjectPaths()).resolves.toContain("alpha");
  });

  it("archives project rows by path prefix", async () => {
    const archivedAt = new Date("2026-06-30T12:00:00.000Z");
    await repo.createProject("Alpha", "alpha");
    await repo.createProject("Nested", "alpha/nested");
    await repo.createProject("Alphabet", "alphabet");

    await repo.archiveProjectsByPathPrefix("alpha", { now: archivedAt });

    await expect(repo.getProjectByPath("alpha")).resolves.toBeNull();
    await expect(repo.getProjectByPath("alpha/nested")).resolves.toBeNull();
    await expect(repo.getProjectRecordByPath("alpha")).resolves.toMatchObject({
      path: "alpha",
      archivedAt,
    });
    await expect(repo.getProjectRecordByPath("alpha/nested")).resolves.toMatchObject({
      path: "alpha/nested",
      archivedAt,
    });
    await expect(repo.listProjectPaths()).resolves.toEqual(["default", "alphabet"]);
  });

  it("archives project rows with SQL LIKE wildcards literally", async () => {
    const archivedAt = new Date("2026-06-30T12:00:00.000Z");
    await repo.createProject("Wildcard", "alpha%");
    await repo.createProject("Wildcard Nested", "alpha%/nested");
    await repo.createProject("Alphabet Nested", "alphabet/nested");

    await repo.archiveProjectsByPathPrefix("alpha%", { now: archivedAt });

    await expect(repo.getProjectRecordByPath("alpha%")).resolves.toMatchObject({
      path: "alpha%",
      archivedAt,
    });
    await expect(repo.getProjectRecordByPath("alpha%/nested")).resolves.toMatchObject({
      path: "alpha%/nested",
      archivedAt,
    });
    await expect(repo.getProjectByPath("alphabet/nested")).resolves.toMatchObject({
      path: "alphabet/nested",
      archivedAt: null,
    });
  });

  it("deletes only archived project rows by path prefix", async () => {
    await repo.createProject("Alpha", "alpha");
    await repo.createProject("Alpha Nested", "alpha/nested");
    await repo.createProject("Alpha Active Child", "alpha/active");
    await repo.createProject("Alphabet", "alphabet");
    await repo.archiveProjectsByPathPrefix("alpha");
    await repo.unarchiveProjectsByPaths(["alpha/active"]);

    await expect(repo.deleteArchivedProjectsByPathPrefix("alpha")).resolves.toBe(2);

    await expect(repo.getProjectRecordByPath("alpha")).resolves.toBeNull();
    await expect(repo.getProjectRecordByPath("alpha/nested")).resolves.toBeNull();
    await expect(repo.getProjectByPath("alpha/active")).resolves.toMatchObject({
      path: "alpha/active",
      archivedAt: null,
    });
    await expect(repo.getProjectByPath("alphabet")).resolves.toMatchObject({
      path: "alphabet",
      archivedAt: null,
    });
  });

  it("deletes archived project rows with SQL LIKE wildcards literally", async () => {
    await repo.createProject("Wildcard", "alpha%");
    await repo.createProject("Wildcard Nested", "alpha%/nested");
    await repo.createProject("Alphabet Nested", "alphabet/nested");
    await repo.archiveProjectsByPathPrefix("alpha%");

    await expect(repo.deleteArchivedProjectsByPathPrefix("alpha%")).resolves.toBe(2);

    await expect(repo.getProjectRecordByPath("alpha%")).resolves.toBeNull();
    await expect(repo.getProjectRecordByPath("alpha%/nested")).resolves.toBeNull();
    await expect(repo.getProjectByPath("alphabet/nested")).resolves.toMatchObject({
      path: "alphabet/nested",
      archivedAt: null,
    });
  });

  it("deletes all session data by project path prefix", async () => {
    await repo.createSession("sess-alpha", "Alpha", undefined, "alpha", null, "alpha");
    await repo.createSession(
      "sess-alpha-child",
      "Alpha Child",
      undefined,
      "alpha",
      null,
      "alpha",
      "designer",
      "webchat_handoff",
    );
    await repo.createSession(
      "sess-alpha-nested",
      "Alpha Nested",
      undefined,
      "nested",
      null,
      "alpha/nested",
    );
    await repo.createSession("sess-alpha-legacy", "Alpha Legacy", undefined, "alpha", null, null);
    await repo.createSession("sess-alphabet", "Alphabet", undefined, "alphabet", null, "alphabet");
    await repo.createSession("sess-legacy-other", "Legacy Other", undefined, "other", null, null);
    await repo.addMessage("msg-alpha", "sess-alpha", "user", "[]", "turn-alpha");
    await repo.addMessage("msg-alpha-child", "sess-alpha-child", "assistant", "[]", "turn-child");
    await repo.addMessage("msg-alpha-nested", "sess-alpha-nested", "user", "[]", "turn-nested");
    await repo.addMessage("msg-alpha-legacy", "sess-alpha-legacy", "user", "[]", "turn-legacy");
    await repo.addMessage("msg-alphabet", "sess-alphabet", "user", "[]", "turn-alphabet");
    await repo.addMessage("msg-legacy-other", "sess-legacy-other", "user", "[]", "turn-other");
    await repo.appendTraceBlocks({
      messageId: "trace-alpha",
      sessionId: "sess-alpha",
      turnId: "turn-alpha",
      startSeq: 0,
      blocks: [{ type: "result", accounting: { costUsd: 0.5, usage: { inputTokens: 10 } } }],
    });
    await repo.insertTurnFeedback("sess-alpha", "turn-alpha", "positive", null);
    await repo.saveLayout("sess-alpha", [{ id: "projects", type: "projects" }]);
    await repo.createSharedChat({
      id: "share-alpha",
      sessionId: "sess-alpha",
      title: "Alpha share",
      snapshot: "{}",
      layout: "[]",
      projectPath: "alpha",
    });

    await expect(repo.listSessionRefsByProjectPathPrefix("alpha")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sess-alpha", type: "webchat", projectPath: "alpha" }),
        expect.objectContaining({
          id: "sess-alpha-child",
          type: "webchat_handoff",
          projectPath: "alpha",
        }),
        expect.objectContaining({
          id: "sess-alpha-nested",
          type: "webchat",
          projectPath: "alpha/nested",
        }),
      ]),
    );

    await expect(repo.deleteSessionsByProjectPathPrefix("alpha")).resolves.toBe(3);

    await expect(repo.getSession("sess-alpha")).resolves.toBeNull();
    await expect(repo.getSession("sess-alpha-child")).resolves.toBeNull();
    await expect(repo.getSession("sess-alpha-nested")).resolves.toBeNull();
    await expect(repo.getSession("sess-alpha-legacy")).resolves.toMatchObject({
      id: "sess-alpha-legacy",
      projectPath: null,
    });
    await expect(repo.getSession("sess-alphabet")).resolves.toMatchObject({ id: "sess-alphabet" });
    await expect(repo.getSession("sess-legacy-other")).resolves.toMatchObject({
      id: "sess-legacy-other",
    });
    await expect(repo.getMessages("sess-alpha")).resolves.toEqual([]);
    await expect(repo.getTraceContents("sess-alpha")).resolves.toEqual([]);
    await expect(repo.getTurnFeedback("sess-alpha", "turn-alpha")).resolves.toBeNull();
    await expect(repo.getLayout("sess-alpha")).resolves.toBeNull();
    await expect(repo.getSharedChat("share-alpha")).resolves.toBeNull();
    await expect(repo.getMessages("sess-alpha-legacy")).resolves.toHaveLength(1);
    await expect(repo.getMessages("sess-alphabet")).resolves.toHaveLength(1);
    await expect(repo.getMessages("sess-legacy-other")).resolves.toHaveLength(1);
  });

  it("does not cascade-delete ambiguous legacy sessions by project name", async () => {
    await repo.createSession("sess-nested", "Nested", undefined, "nested", null, "nested");
    await repo.createSession(
      "sess-legacy-nested",
      "Legacy Nested",
      undefined,
      "nested",
      null,
      null,
    );
    await repo.createSession(
      "sess-missing-nested",
      "Missing Nested",
      undefined,
      "nested",
      null,
      "missing/nested",
    );
    await repo.addMessage("msg-nested", "sess-nested", "user", "[]");
    await repo.addMessage("msg-legacy-nested", "sess-legacy-nested", "user", "[]");
    await repo.addMessage("msg-missing-nested", "sess-missing-nested", "user", "[]");

    await expect(repo.listSessionRefsByProjectPathPrefix("nested")).resolves.toEqual([
      expect.objectContaining({ id: "sess-nested", projectPath: "nested" }),
    ]);
    await expect(repo.deleteSessionsByProjectPathPrefix("nested")).resolves.toBe(1);

    await expect(repo.getSession("sess-nested")).resolves.toBeNull();
    await expect(repo.getSession("sess-legacy-nested")).resolves.toMatchObject({
      id: "sess-legacy-nested",
      projectPath: null,
    });
    await expect(repo.getSession("sess-missing-nested")).resolves.toMatchObject({
      id: "sess-missing-nested",
      projectPath: "missing/nested",
    });
    await expect(repo.getMessages("sess-legacy-nested")).resolves.toHaveLength(1);
    await expect(repo.getMessages("sess-missing-nested")).resolves.toHaveLength(1);
  });

  it("deletes sessions with SQL LIKE wildcards literally", async () => {
    await repo.createSession("sess-wild", "Wildcard", undefined, "alpha%", null, "alpha%");
    await repo.createSession(
      "sess-wild-nested",
      "Wildcard Nested",
      undefined,
      "nested",
      null,
      "alpha%/nested",
    );
    await repo.createSession(
      "sess-alphabet-nested",
      "Alphabet Nested",
      undefined,
      "nested",
      null,
      "alphabet/nested",
    );

    await expect(repo.listSessionRefsByProjectPathPrefix("alpha%")).resolves.toEqual([
      expect.objectContaining({ id: "sess-wild", projectPath: "alpha%" }),
      expect.objectContaining({ id: "sess-wild-nested", projectPath: "alpha%/nested" }),
    ]);
    await expect(repo.deleteSessionsByProjectPathPrefix("alpha%")).resolves.toBe(2);

    await expect(repo.getSession("sess-wild")).resolves.toBeNull();
    await expect(repo.getSession("sess-wild-nested")).resolves.toBeNull();
    await expect(repo.getSession("sess-alphabet-nested")).resolves.toMatchObject({
      id: "sess-alphabet-nested",
    });
  });

  describe("deleteSessionsByProjectPathPrefix id read", () => {
    it("reads the session ids inside the same transaction as the deletes", async () => {
      await repo.createSession("sess-tx", "Tx", undefined, "alpha", null, "alpha");
      const { db, statements } = trackStatements(testDb.db);
      const trackedRepo = new WebChatRepository(db);

      await expect(trackedRepo.deleteSessionsByProjectPathPrefix("alpha")).resolves.toBe(1);

      // A `select` on the connection itself means the id list was read in its
      // own autocommit statement before the transaction opened.
      expect(statements).toEqual(["transaction"]);
    });

    it("deletes a session created for the project after the id read", async () => {
      await repo.createSession("sess-alpha", "Alpha", undefined, "alpha", null, "alpha");
      await repo.createSession("sess-other", "Other", undefined, "other", null, "other");

      // Stand in for the concurrent create that lands in the window between the
      // id read and the deletes. Reading the ids first leaves this session
      // pointing at a project that no longer exists.
      const original = testDb.db.transaction.bind(testDb.db);
      const spy = rs
        .spyOn(testDb.db, "transaction")
        .mockImplementation((cb: Parameters<typeof original>[0]) => {
          const now = new Date();
          testDb.db
            .insert(romeSessions)
            .values({
              id: "sess-alpha-raced",
              name: "Alpha Raced",
              projectName: "alpha",
              projectPath: "alpha",
              type: "webchat",
              createdAt: now,
              activityAt: now,
            })
            .run();
          return original(cb);
        });

      await expect(repo.deleteSessionsByProjectPathPrefix("alpha")).resolves.toBe(2);
      spy.mockRestore();

      await expect(repo.listSessionRefsByProjectPathPrefix("alpha")).resolves.toEqual([]);
      await expect(repo.getSession("sess-alpha")).resolves.toBeNull();
      await expect(repo.getSession("sess-alpha-raced")).resolves.toBeNull();
      await expect(repo.getSession("sess-other")).resolves.toMatchObject({ id: "sess-other" });
    });

    it("returns 0 and deletes nothing when no session matches the prefix", async () => {
      await repo.createSession("sess-other", "Other", undefined, "other", null, "other");

      await expect(repo.deleteSessionsByProjectPathPrefix("alpha")).resolves.toBe(0);

      await expect(repo.getSession("sess-other")).resolves.toMatchObject({ id: "sess-other" });
    });
  });

  it("pages project sessions by latest chat activity", async () => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));
    await repo.createSession("sess-old", "Old Chat", undefined, "alpha", null, "alpha");
    await repo.createSession("sess-new", "New Chat", undefined, "alpha", null, "alpha");
    rs.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await repo.addMessage("msg-old", "sess-old", "user", "[]");
    rs.setSystemTime(new Date("2030-01-01T00:00:01.000Z"));
    await repo.addMessage("msg-old-latest", "sess-old", "assistant", "[]");

    const firstPage = await repo.listSessionsByProjectPath("alpha", { limit: 1 });
    const secondPage = await repo.listSessionsByProjectPath("alpha", {
      cursor: firstPage.nextCursor ?? undefined,
      limit: 1,
    });

    expect(firstPage.sessions.map((session) => session.id)).toEqual(["sess-old"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.total).toBe(2);
    expect(secondPage.sessions.map((session) => session.id)).toEqual(["sess-new"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("pages all sessions by latest chat activity including null project paths", async () => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));
    await repo.createSession("sess-alpha", "Alpha Chat", undefined, "alpha", null, "alpha");
    await repo.createSession("sess-null", "Legacy Chat", undefined, "legacy", null, null);
    await repo.createSession("sess-other", "Other Chat", undefined, "other", null, "other");
    rs.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await repo.addMessage("msg-alpha", "sess-alpha", "user", "[]");
    rs.setSystemTime(new Date("2030-01-03T00:00:00.000Z"));
    await repo.addMessage("msg-null", "sess-null", "user", "[]");
    rs.setSystemTime(new Date("2030-01-02T00:00:00.000Z"));
    await repo.addMessage("msg-other", "sess-other", "assistant", "[]");

    const firstPage = await repo.listSessionsPage({ limit: 2 });
    const secondPage = await repo.listSessionsPage({
      cursor: firstPage.nextCursor ?? undefined,
      limit: 2,
    });

    expect(firstPage.sessions.map((session) => session.id)).toEqual(["sess-null", "sess-other"]);
    expect(firstPage.sessions[0]).toMatchObject({
      id: "sess-null",
      messageCount: 1,
      projectPath: null,
    });
    expect(firstPage.total).toBe(3);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.sessions.map((session) => session.id)).toEqual(["sess-alpha"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("tracks unread state from session activity", async () => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));
    await repo.createSession("sess-read", "Read Chat");
    await expect(repo.getSession("sess-read")).resolves.toMatchObject({
      activityAt: new Date("2029-01-01T00:00:00.000Z"),
      lastSeenActivityAt: new Date("2029-01-01T00:00:00.000Z"),
    });

    rs.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await repo.addMessage("msg-read", "sess-read", "assistant", "[]");
    let sessions = await repo.listSessions();
    expect(sessions.find((session) => session.id === "sess-read")).toMatchObject({
      unread: true,
      activityAt: Math.floor(new Date("2030-01-01T00:00:00.000Z").getTime() / 1000),
      lastSeenActivityAt: new Date("2029-01-01T00:00:00.000Z"),
    });

    await repo.markSessionRead("sess-read");
    sessions = await repo.listSessions();
    expect(sessions.find((session) => session.id === "sess-read")).toMatchObject({
      unread: false,
      lastSeenActivityAt: new Date("2030-01-01T00:00:00.000Z"),
    });
  });

  describe("archive", () => {
    it("archives and unarchives a webchat session", async () => {
      const archivedAt = new Date("2026-07-14T12:00:00.000Z");
      await repo.createSession("sess-arch", "Archive me");

      await expect(repo.getSession("sess-arch")).resolves.toMatchObject({ archivedAt: null });

      await repo.archiveSession("sess-arch", { now: archivedAt });
      await expect(repo.getSession("sess-arch")).resolves.toMatchObject({ archivedAt });

      await repo.unarchiveSession("sess-arch");
      await expect(repo.getSession("sess-arch")).resolves.toMatchObject({ archivedAt: null });
    });

    it("exposes archivedAt in listSessions rows", async () => {
      const archivedAt = new Date("2026-07-14T12:00:00.000Z");
      await repo.createSession("sess-arch", "Archive me");
      await repo.archiveSession("sess-arch", { now: archivedAt });

      const rows = await repo.listSessions("all");
      expect(rows.find((s) => s.id === "sess-arch")).toMatchObject({ archivedAt });
    });

    it("filters listSessions by archive status", async () => {
      await repo.createSession("sess-active", "Active chat");
      await repo.createSession("sess-archived", "Archived chat");
      await repo.archiveSession("sess-archived");

      const active = await repo.listSessions("active");
      expect(active.map((s) => s.id).sort()).toEqual(["sess-active"]);

      const archived = await repo.listSessions("archived");
      expect(archived.map((s) => s.id).sort()).toEqual(["sess-archived"]);

      const all = await repo.listSessions("all");
      expect(all.map((s) => s.id).sort()).toEqual(["sess-active", "sess-archived"]);

      // Default is "active".
      const byDefault = await repo.listSessions();
      expect(byDefault.map((s) => s.id).sort()).toEqual(["sess-active"]);
    });

    it("does not archive non-webchat session types", async () => {
      await repo.ensureRomeSession({
        id: "sess-channel",
        type: "channel",
        name: "Channel session",
        agentName: null,
      });

      await repo.archiveSession("sess-channel");
      await expect(repo.getSession("sess-channel")).resolves.toMatchObject({ archivedAt: null });

      // And it never appears in the sidebar listing regardless of status.
      const all = await repo.listSessions("all");
      expect(all.find((s) => s.id === "sess-channel")).toBeUndefined();
    });
  });

  describe("pin", () => {
    it("pins and unpins a webchat session on the server", async () => {
      const pinnedAt = new Date("2026-07-24T12:00:00.000Z");
      await repo.createSession("sess-pin", "Pin me");

      await expect(repo.getSession("sess-pin")).resolves.toMatchObject({ pinnedAt: null });

      await repo.pinSession("sess-pin", { now: pinnedAt });
      await expect(repo.getSession("sess-pin")).resolves.toMatchObject({ pinnedAt });
      expect(
        (await repo.listSessions()).find((session) => session.id === "sess-pin"),
      ).toMatchObject({ pinnedAt });

      await repo.unpinSession("sess-pin");
      await expect(repo.getSession("sess-pin")).resolves.toMatchObject({ pinnedAt: null });
    });

    it("does not pin non-webchat session types", async () => {
      await repo.ensureRomeSession({
        id: "sess-channel-pin",
        type: "channel",
        name: "Channel session",
        agentName: null,
      });

      await repo.pinSession("sess-channel-pin");
      await expect(repo.getSession("sess-channel-pin")).resolves.toMatchObject({ pinnedAt: null });
    });
  });

  it("does not advance chat activity for trace-only writes", async () => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));
    await repo.createSession("sess-trace", "Trace Chat");

    rs.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await repo.addMessage("trace-only", "sess-trace", "trace", "[]");

    await expect(repo.getSession("sess-trace")).resolves.toMatchObject({
      activityAt: new Date("2029-01-01T00:00:00.000Z"),
      lastSeenActivityAt: new Date("2029-01-01T00:00:00.000Z"),
    });
  });

  it("stores and retrieves a selected project name and path", async () => {
    await repo.createSession("sess-3", "Chat C");
    await repo.updateSessionProject("sess-3", "content", "landingpage/content");

    await expect(repo.getSession("sess-3")).resolves.toMatchObject({
      id: "sess-3",
      projectName: "content",
      projectPath: "landingpage/content",
    });
  });

  it("stores an initial project name when creating a session", async () => {
    await repo.createSession(
      "sess-project",
      "Chat Project",
      undefined,
      "content",
      null,
      "alpha/content",
    );

    await expect(repo.getSession("sess-project")).resolves.toMatchObject({
      id: "sess-project",
      projectName: "content",
      projectPath: "alpha/content",
    });
  });

  it("updates persisted message content", async () => {
    await repo.createSession("sess-4", "Chat D");
    await repo.addMessage(
      "msg-2",
      "sess-4",
      "trace",
      JSON.stringify([{ type: "thinking", content: "partial" }]),
    );

    const updatedContent = JSON.stringify([
      { type: "thinking", content: "partial" },
      { type: "result", content: "done" },
    ]);

    await repo.updateMessageContent("msg-2", updatedContent);

    // getMessages returns empty content for trace messages (lazy loading)
    await expect(repo.getMessages("sess-4")).resolves.toEqual([
      expect.objectContaining({
        id: "msg-2",
        role: "trace",
        content: "[]",
      }),
    ]);

    // getMessageContent returns the full content
    await expect(repo.getMessageContent("msg-2")).resolves.toEqual(updatedContent);
  });

  it("updates trace accounting columns when persisted trace content changes", async () => {
    await repo.createSession("sess-accounting-update", "Accounting Update");
    await repo.addMessage("msg-accounting-update", "sess-accounting-update", "trace", "[]");

    await repo.updateMessageContent(
      "msg-accounting-update",
      JSON.stringify([
        {
          type: "result",
          content: "done",
          accounting: {
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              cacheReadTokens: 2,
              cacheWriteTokens: 3,
              inputTokens: 11,
              outputTokens: 5,
            },
            costUsd: 0.12,
          },
        },
      ]),
    );

    await expect(
      repo.getProjectUsageTotals("default", {
        monthStart: new Date("2000-01-01T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      monthCostUsd: 0.12,
      totalCostUsd: 0.12,
      totalTokens: 21,
    });
  });

  it("getMessageContent returns null for non-existent message", async () => {
    await expect(repo.getMessageContent("does-not-exist")).resolves.toBeNull();
  });

  describe("appendTraceBlocks", () => {
    const resultBlock = {
      type: "result",
      content: "done",
      accounting: {
        provider: "openai",
        model: "gpt-5.4",
        usage: { cacheReadTokens: 2, cacheWriteTokens: 3, inputTokens: 11, outputTokens: 5 },
        costUsd: 0.12,
      },
    };

    it("appends tail batches and serves the merged trace from every read path", async () => {
      await repo.createSession("sess-append", "Append");
      const blocks = [
        { type: "thinking", content: "hmm" },
        { type: "tool_use", id: "tu-1", tool: "some_tool", input: {} },
        { type: "tool_result", toolUseId: "tu-1", tool: "some_tool", output: {} },
        resultBlock,
      ];

      // Two batches, the way persistTrace appends as events arrive.
      await repo.appendTraceBlocks({
        messageId: "msg-append",
        sessionId: "sess-append",
        turnId: "turn-append",
        startSeq: 0,
        blocks: blocks.slice(0, 2),
      });
      await repo.appendTraceBlocks({
        messageId: "msg-append",
        sessionId: "sess-append",
        turnId: "turn-append",
        startSeq: 2,
        blocks: blocks.slice(2),
      });

      const expected = JSON.stringify(blocks);
      await expect(repo.getMessageContent("msg-append")).resolves.toEqual(expected);
      await expect(repo.getTraceContents("sess-append")).resolves.toEqual([
        { id: "msg-append", content: expected },
      ]);
      await expect(repo.getTraceContentByTurn("sess-append", "turn-append")).resolves.toEqual({
        id: "msg-append",
        content: expected,
      });

      // Exactly one stub trace message row, lazy '[]' in the listing.
      await expect(repo.getMessages("sess-append")).resolves.toEqual([
        expect.objectContaining({
          id: "msg-append",
          role: "trace",
          turnId: "turn-append",
          content: "[]",
        }),
      ]);
    });

    it("updates accounting columns when the terminal block arrives in a later batch", async () => {
      await repo.createSession("sess-append-accounting", "Append Accounting");
      await repo.appendTraceBlocks({
        messageId: "msg-append-accounting",
        sessionId: "sess-append-accounting",
        turnId: "turn-1",
        startSeq: 0,
        blocks: [{ type: "thinking", content: "no accounting yet" }],
      });
      await repo.appendTraceBlocks({
        messageId: "msg-append-accounting",
        sessionId: "sess-append-accounting",
        turnId: "turn-1",
        startSeq: 1,
        blocks: [resultBlock],
      });

      await expect(
        repo.getProjectUsageTotals("default", {
          monthStart: new Date("2000-01-01T00:00:00.000Z"),
        }),
      ).resolves.toMatchObject({
        monthCostUsd: 0.12,
        totalCostUsd: 0.12,
        totalTokens: 21,
      });
    });

    it("leaves legacy full-content traces untouched on every read path", async () => {
      await repo.createSession("sess-legacy-trace", "Legacy Trace");
      const legacyContent = JSON.stringify([{ type: "thinking", content: "legacy" }]);
      await repo.addMessage("msg-legacy-trace", "sess-legacy-trace", "trace", legacyContent, "t-1");

      await expect(repo.getMessageContent("msg-legacy-trace")).resolves.toEqual(legacyContent);
      await expect(repo.getTraceContents("sess-legacy-trace")).resolves.toEqual([
        { id: "msg-legacy-trace", content: legacyContent },
      ]);
      await expect(repo.getTraceContentByTurn("sess-legacy-trace", "t-1")).resolves.toEqual({
        id: "msg-legacy-trace",
        content: legacyContent,
      });
    });

    it("loads multiple session and turn trace pairs in one batch", async () => {
      await repo.createSession("sess-batch-a", "Batch A");
      await repo.createSession("sess-batch-b", "Batch B");
      await repo.appendTraceBlocks({
        messageId: "msg-batch-a",
        sessionId: "sess-batch-a",
        turnId: "turn-batch-a",
        startSeq: 0,
        blocks: [{ type: "thinking", content: "a" }, resultBlock],
      });
      await repo.appendTraceBlocks({
        messageId: "msg-batch-b",
        sessionId: "sess-batch-b",
        turnId: "turn-batch-b",
        startSeq: 0,
        blocks: [{ type: "thinking", content: "b" }, resultBlock],
      });
      await repo.appendTraceBlocks({
        messageId: "msg-batch-cross-pair",
        sessionId: "sess-batch-a",
        turnId: "turn-batch-b",
        startSeq: 0,
        blocks: [{ type: "thinking", content: "cross pair" }, resultBlock],
      });

      await expect(
        repo.getTraceContentsByTurns([
          { sessionId: "sess-batch-a", turnId: "turn-batch-a" },
          { sessionId: "sess-batch-b", turnId: "turn-batch-b" },
          { sessionId: "sess-batch-a", turnId: "turn-batch-a" },
        ]),
      ).resolves.toEqual([
        {
          id: "msg-batch-a",
          sessionId: "sess-batch-a",
          turnId: "turn-batch-a",
          content: JSON.stringify([{ type: "thinking", content: "a" }, resultBlock]),
        },
        {
          id: "msg-batch-b",
          sessionId: "sess-batch-b",
          turnId: "turn-batch-b",
          content: JSON.stringify([{ type: "thinking", content: "b" }, resultBlock]),
        },
      ]);
      await expect(repo.getTraceContentsByTurns([])).resolves.toEqual([]);
    });

    it("rejects a replayed seq atomically without double-counting accounting", async () => {
      await repo.createSession("sess-replay", "Replay");
      await repo.appendTraceBlocks({
        messageId: "msg-replay",
        sessionId: "sess-replay",
        turnId: "turn-replay",
        startSeq: 0,
        blocks: [resultBlock],
      });

      // Same startSeq again — the (message_id, seq) PK must refuse it and the
      // transaction must roll back the accounting bump alongside the insert.
      await expect(
        repo.appendTraceBlocks({
          messageId: "msg-replay",
          sessionId: "sess-replay",
          turnId: "turn-replay",
          startSeq: 0,
          blocks: [resultBlock],
        }),
      ).rejects.toThrow();

      await expect(repo.getMessageContent("msg-replay")).resolves.toEqual(
        JSON.stringify([resultBlock]),
      );
      await expect(
        repo.getProjectUsageTotals("default", {
          monthStart: new Date("2000-01-01T00:00:00.000Z"),
        }),
      ).resolves.toMatchObject({ totalCostUsd: 0.12, totalTokens: 21 });
    });

    it("is a no-op for an empty batch", async () => {
      await repo.createSession("sess-empty-batch", "Empty Batch");
      await repo.appendTraceBlocks({
        messageId: "msg-empty-batch",
        sessionId: "sess-empty-batch",
        turnId: "turn-empty",
        startSeq: 0,
        blocks: [],
      });
      await expect(repo.getMessages("sess-empty-batch")).resolves.toEqual([]);
    });

    it("deleteSession and deleteMessagesBySession remove trace block rows", async () => {
      const countBlocks = async (sessionId: string) => {
        const rows = await testDb.db
          .select({ count: sql<number>`count(*)`.mapWith(Number) })
          .from(romeAgentTraceBlocks)
          .where(eq(romeAgentTraceBlocks.sessionId, sessionId));
        return rows[0]?.count ?? 0;
      };

      await repo.createSession("sess-del-blocks", "Delete Blocks");
      await repo.appendTraceBlocks({
        messageId: "msg-del-blocks",
        sessionId: "sess-del-blocks",
        turnId: "turn-del",
        startSeq: 0,
        blocks: [{ type: "thinking", content: "x" }],
      });
      await expect(countBlocks("sess-del-blocks")).resolves.toBe(1);
      await repo.deleteMessagesBySession("sess-del-blocks");
      await expect(countBlocks("sess-del-blocks")).resolves.toBe(0);
      await expect(repo.getMessages("sess-del-blocks")).resolves.toEqual([]);

      await repo.createSession("sess-del-session", "Delete Session");
      await repo.appendTraceBlocks({
        messageId: "msg-del-session",
        sessionId: "sess-del-session",
        turnId: "turn-del-2",
        startSeq: 0,
        blocks: [{ type: "thinking", content: "y" }],
      });
      await expect(countBlocks("sess-del-session")).resolves.toBe(1);
      await repo.deleteSession("sess-del-session");
      await expect(countBlocks("sess-del-session")).resolves.toBe(0);
    });
  });

  describe("detached child status reads", () => {
    // Mirrors what AgentTraceRecorder writes for one child turn: a user row, a
    // trace whose blocks bracket the turn, and (when the turn produced one) an
    // assistant row.
    async function recordTurn(
      sessionId: string,
      turnId: string,
      options: {
        at: string;
        prompt: string;
        reply?: string;
        turnEnd?: "completed" | "error" | "interrupted";
        error?: string;
      },
    ) {
      rs.setSystemTime(new Date(options.at));
      const blocks: unknown[] = [{ type: "turn_start", turnId, userPrompt: options.prompt }];
      if (options.reply !== undefined) blocks.push({ type: "result", content: options.reply });
      if (options.error !== undefined) blocks.push({ type: "error", error: options.error });
      if (options.turnEnd) blocks.push({ type: "turn_end", turnId, status: options.turnEnd });
      await repo.appendTraceBlocks({
        messageId: `trace:${sessionId}:${turnId}`,
        sessionId,
        turnId,
        startSeq: 0,
        blocks,
        transcriptMessages: [
          {
            id: `transcript:${sessionId}:${turnId}:user`,
            sessionId,
            role: "user",
            content: JSON.stringify([{ type: "text", content: options.prompt }]),
            turnId,
          },
          ...(options.reply !== undefined
            ? [
                {
                  id: `transcript:${sessionId}:${turnId}:assistant`,
                  sessionId,
                  role: "assistant" as const,
                  content: JSON.stringify([{ type: "text", content: options.reply }]),
                  turnId,
                },
              ]
            : []),
        ],
      });
    }

    beforeEach(() => {
      rs.useFakeTimers();
    });

    it("reports the newest turn's outcome, not the first one's", async () => {
      await repo.createSession("child-many", "Child");
      await recordTurn("child-many", "turn-1", {
        at: "2030-01-01T00:00:00.000Z",
        prompt: "first",
        reply: "first answer",
        turnEnd: "completed",
      });
      await recordTurn("child-many", "turn-2", {
        at: "2030-01-01T01:00:00.000Z",
        prompt: "second",
        reply: "second answer",
        turnEnd: "completed",
      });

      await expect(repo.getLatestTurnOutcome("child-many")).resolves.toEqual({
        turnId: "turn-2",
        turnEndStatus: "completed",
        error: null,
        reply: "second answer",
      });
    });

    it("reports the last-written turn when two land in the same second", async () => {
      // createdAt stores whole seconds, so back-to-back turns tie on it. The
      // ids are uuids, which makes an id tiebreak a coin flip.
      await repo.createSession("child-fast", "Child");
      await recordTurn("child-fast", "turn-1", {
        at: "2030-01-01T00:00:00.000Z",
        prompt: "first",
        reply: "first answer",
        turnEnd: "completed",
      });
      await recordTurn("child-fast", "turn-2", {
        at: "2030-01-01T00:00:00.900Z",
        prompt: "second",
        reply: "second answer",
        turnEnd: "error",
        error: "model refused",
      });

      await expect(repo.getLatestTurnOutcome("child-fast")).resolves.toEqual({
        turnId: "turn-2",
        turnEndStatus: "error",
        error: "model refused",
        reply: "second answer",
      });
      await expect(repo.getRecentTranscript("child-fast", 2)).resolves.toEqual([
        { role: "user", turnId: "turn-2", text: "second", createdAt: expect.any(Date) },
        { role: "assistant", turnId: "turn-2", text: "second answer", createdAt: expect.any(Date) },
      ]);
    });

    it("carries the terminal error text of a failed turn", async () => {
      await repo.createSession("child-failed", "Child");
      await recordTurn("child-failed", "turn-1", {
        at: "2030-01-01T00:00:00.000Z",
        prompt: "go",
        turnEnd: "error",
        error: "model refused",
      });

      await expect(repo.getLatestTurnOutcome("child-failed")).resolves.toEqual({
        turnId: "turn-1",
        turnEndStatus: "error",
        error: "model refused",
        reply: null,
      });
    });

    it("leaves turnEndStatus null for a turn that never closed", async () => {
      await repo.createSession("child-cut", "Child");
      await recordTurn("child-cut", "turn-1", {
        at: "2030-01-01T00:00:00.000Z",
        prompt: "go",
      });

      await expect(repo.getLatestTurnOutcome("child-cut")).resolves.toEqual({
        turnId: "turn-1",
        turnEndStatus: null,
        error: null,
        reply: null,
      });
    });

    it("returns null for a session that has recorded no turn", async () => {
      await repo.createSession("child-empty", "Child");
      await expect(repo.getLatestTurnOutcome("child-empty")).resolves.toBeNull();
      await expect(repo.getLatestTurnOutcome("no-such-session")).resolves.toBeNull();
    });

    it("returns the last N chat rows oldest-first and never a trace row", async () => {
      await repo.createSession("child-tail", "Child");
      await recordTurn("child-tail", "turn-1", {
        at: "2030-01-01T00:00:00.000Z",
        prompt: "one",
        reply: "answer one",
        turnEnd: "completed",
      });
      await recordTurn("child-tail", "turn-2", {
        at: "2030-01-01T01:00:00.000Z",
        prompt: "two",
        reply: "answer two",
        turnEnd: "completed",
      });

      await expect(repo.getRecentTranscript("child-tail", 3)).resolves.toEqual([
        { role: "assistant", turnId: "turn-1", text: "answer one", createdAt: expect.any(Date) },
        { role: "user", turnId: "turn-2", text: "two", createdAt: expect.any(Date) },
        { role: "assistant", turnId: "turn-2", text: "answer two", createdAt: expect.any(Date) },
      ]);
      await expect(repo.getRecentTranscript("child-tail", 100)).resolves.toHaveLength(4);
      await expect(repo.getRecentTranscript("child-tail", 0)).resolves.toEqual([]);
      await expect(repo.getRecentTranscript("child-tail", -1)).resolves.toEqual([]);
    });
  });

  it("groups messages by turnId so concurrent turns render in turn order", async () => {
    // Reproduces the user-A / user-B / reply-A / reply-B insertion pattern
    // that happens when two POSTs race on the same session. With turnId
    // grouping, getMessages should return them as user-A / reply-A / user-B
    // / reply-B (each turn's rows kept contiguous, group ordered by the
    // user row's createdAt).
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await repo.createSession("sess-order", "Chat Order");

    await repo.addMessage("u1", "sess-order", "user", "[]", "turn-A");
    await sleep(2);
    await repo.addMessage("u2", "sess-order", "user", "[]", "turn-B");
    await sleep(2);
    await repo.addMessage("t1", "sess-order", "trace", "[]", "turn-A");
    await sleep(2);
    await repo.addMessage("t2", "sess-order", "trace", "[]", "turn-B");

    const messages = await repo.getMessages("sess-order");
    expect(messages.map((m) => m.id)).toEqual(["u1", "t1", "u2", "t2"]);
  });

  it("stores turn recap messages in the original turn group even when inserted late", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await repo.createSession("sess-recap-order", "Recap Order");

    await repo.addMessage("a-user", "sess-recap-order", "user", "[]", "turn-A");
    await sleep(2);
    await repo.addMessage("a-assistant", "sess-recap-order", "assistant", "[]", "turn-A");
    await sleep(2);
    await repo.addMessage("b-user", "sess-recap-order", "user", "[]", "turn-B");
    await sleep(2);
    await repo.addMessage("b-assistant", "sess-recap-order", "assistant", "[]", "turn-B");
    await sleep(2);
    const recap = await repo.addTurnRecapMessage({
      sessionId: "sess-recap-order",
      turnId: "turn-A",
      content: "The first turn was summarized after turn B already existed.",
    });

    const messages = await repo.getMessages("sess-recap-order");
    expect(messages.map((m) => m.id)).toEqual([
      "a-user",
      "a-assistant",
      recap.id,
      "b-user",
      "b-assistant",
    ]);
    expect(JSON.parse(recap.content)).toEqual([
      {
        type: "turn_recap",
        turnId: "turn-A",
        content: "The first turn was summarized after turn B already existed.",
      },
    ]);
  });

  it("allows multiple turn recap messages for the same turn and emits inserts", async () => {
    await repo.createSession("sess-recap-multiple", "Recap Multiple");
    await repo.addMessage("anchor", "sess-recap-multiple", "user", "[]", "turn-1");
    const inserted: string[] = [];
    const unsubscribe = repo.onMessageInserted((message) => inserted.push(message.id));

    const first = await repo.addTurnRecapMessage({
      sessionId: "sess-recap-multiple",
      turnId: "turn-1",
      content: "First recap",
    });
    const second = await repo.addTurnRecapMessage({
      sessionId: "sess-recap-multiple",
      turnId: "turn-1",
      content: "Second recap",
      audioUrl: "/api/projects/asset/audio.mp3?path=projects/default/.rome/recaps/turn-1/audio.mp3",
      audioMimeType: "audio/mpeg",
      audioDurationMs: 7400,
    });
    unsubscribe();

    expect(first.id).not.toBe(second.id);
    expect(inserted).toEqual([first.id, second.id]);
    await expect(repo.getMessages("sess-recap-multiple")).resolves.toEqual([
      expect.objectContaining({ id: "anchor" }),
      expect.objectContaining({ id: first.id }),
      expect.objectContaining({ id: second.id }),
    ]);
  });

  it("rejects recap audio URLs outside the project asset route and logical root", () => {
    const valid = "/projects/asset?path=projects/demo/.rome/recaps/turn-1/audio.mp3";
    expect(validateTurnRecapAudioUrl(valid)).toBe(valid);

    for (const url of [
      "https://example.com/audio.mp3",
      "//example.com/audio.mp3",
      "/projects/asset?path=/etc/passwd",
      "/projects/asset?path=projects/demo/../secret.mp3",
      "/projects/asset",
      "/projects/asset/foo/bar?path=projects/demo/audio.mp3",
      "/projects/asset/foo%2Fbar?path=projects/demo/audio.mp3",
      "/api/projects/asset/foo/bar?path=projects/demo/audio.mp3",
      "/memory/asset?path=projects/demo/audio.mp3",
      "/projects/asset?path=memory/demo/audio.mp3",
      "/projects/asset?path=projects\\demo\\audio.mp3",
    ]) {
      expect(() => validateTurnRecapAudioUrl(url)).toThrow();
    }
  });

  it("treats messages with null turnId as singleton groups (legacy rows)", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await repo.createSession("sess-legacy", "Chat Legacy");

    await repo.addMessage("first", "sess-legacy", "user", "[]");
    await sleep(2);
    await repo.addMessage("second", "sess-legacy", "trace", "[]");

    const messages = await repo.getMessages("sess-legacy");
    expect(messages.map((m) => m.id)).toEqual(["first", "second"]);
  });

  it("gets messages for multiple sessions while preserving per-session turn order", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await repo.createSession("sess-batch-a", "Batch A");
    await repo.createSession("sess-batch-b", "Batch B");

    await repo.addMessage("a-user", "sess-batch-a", "user", "[]", "turn-A");
    await sleep(2);
    await repo.addMessage("b-user", "sess-batch-b", "user", "[]", "turn-B");
    await sleep(2);
    await repo.addMessage("a-trace", "sess-batch-a", "trace", '[{"type":"thinking"}]', "turn-A");
    await sleep(2);
    await repo.addMessage("b-assistant", "sess-batch-b", "assistant", "[]", "turn-B");

    const messages = await repo.getMessagesBatch(["sess-batch-a", "sess-batch-b"]);
    const bySession = new Map<string, string[]>();
    for (const message of messages) {
      bySession.set(message.sessionId, [...(bySession.get(message.sessionId) ?? []), message.id]);
    }

    expect(bySession.get("sess-batch-a")).toEqual(["a-user", "a-trace"]);
    expect(bySession.get("sess-batch-b")).toEqual(["b-user", "b-assistant"]);
    expect(messages.find((message) => message.id === "a-trace")?.content).toBe("[]");
  });

  it("aggregates project usage totals from trace accounting columns", async () => {
    const monthStart = new Date("2030-02-01T00:00:00.000Z");
    const beforeMonth = new Date("2030-01-31T23:00:00.000Z");
    const inMonth = new Date("2030-02-02T12:00:00.000Z");
    const belowThreshold = new Date("2030-01-01T00:00:00.000Z");
    const localDate = (date: Date) =>
      [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("-");

    await repo.createSession("sess-usage-a", "Usage A", undefined, "alpha", null, "alpha");
    await repo.createSession("sess-usage-b", "Usage B", undefined, "alpha", null, "alpha");
    await repo.createSession("sess-usage-other", "Usage Other", undefined, "other", null, "other");
    await repo.addMessage(
      "trace-before-month",
      "sess-usage-a",
      "trace",
      JSON.stringify([
        {
          type: "result",
          content: "done",
          accounting: {
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              cacheReadTokens: 3,
              cacheWriteTokens: 4,
              inputTokens: 10,
              outputTokens: 5,
            },
            costUsd: 0.1,
          },
        },
      ]),
    );
    await repo.addMessage(
      "trace-in-month",
      "sess-usage-b",
      "trace",
      JSON.stringify([
        {
          type: "result",
          content: "done",
          accounting: {
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              cacheReadTokens: 1,
              cacheWriteTokens: 2,
              inputTokens: 20,
              outputTokens: 7,
            },
            costUsd: 0.2,
          },
        },
        {
          type: "error",
          error: "failed",
          accounting: {
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              cacheReadTokens: 0,
              cacheWriteTokens: 1,
              inputTokens: 2,
              outputTokens: 3,
            },
            costUsd: 0.03,
          },
        },
      ]),
    );
    await repo.addMessage(
      "trace-below-threshold",
      "sess-usage-b",
      "trace",
      JSON.stringify([
        {
          type: "result",
          content: "old",
          accounting: {
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              cacheReadTokens: 1,
              cacheWriteTokens: 1,
              inputTokens: 1,
              outputTokens: 1,
            },
            costUsd: 0.01,
          },
        },
      ]),
    );
    await repo.addMessage(
      "trace-other-project",
      "sess-usage-other",
      "trace",
      JSON.stringify([
        {
          type: "result",
          content: "other",
          accounting: {
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              cacheReadTokens: 100,
              cacheWriteTokens: 100,
              inputTokens: 100,
              outputTokens: 100,
            },
            costUsd: 9,
          },
        },
      ]),
    );

    for (const [id, createdAt] of [
      ["trace-before-month", beforeMonth],
      ["trace-in-month", inMonth],
      ["trace-below-threshold", belowThreshold],
      ["trace-other-project", inMonth],
    ] as const) {
      await testDb.db
        .update(romeAgentMessages)
        .set({ createdAt })
        .where(eq(romeAgentMessages.id, id));
    }

    const totals = await repo.getProjectUsageTotals("alpha", {
      dayStart: new Date("2030-01-15T00:00:00.000Z"),
      monthStart,
    });

    expect(totals.totalTokens).toBe(62);
    expect(totals.totalInputTokens).toBe(33);
    expect(totals.totalCacheReadTokens).toBe(5);
    expect(totals.totalCacheWriteTokens).toBe(8);
    expect(totals.totalCostUsd).toBeCloseTo(0.34);
    expect(totals.monthCostUsd).toBeCloseTo(0.23);
    expect(totals.monthTokens).toBe(36);
    expect(totals.days).toEqual([
      {
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsd: 0.1,
        date: localDate(beforeMonth),
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        cacheReadTokens: 1,
        cacheWriteTokens: 3,
        costUsd: 0.23,
        date: localDate(inMonth),
        inputTokens: 22,
        outputTokens: 10,
      },
    ]);
  });

  it("returns zero usage totals for empty projects", async () => {
    await expect(
      repo.getProjectUsageTotals("missing", {
        dayStart: new Date("2030-01-01T00:00:00.000Z"),
        monthStart: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      days: [],
      monthCostUsd: 0,
      monthTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalTokens: 0,
    });
  });

  it("aggregates usage totals across all sessions including null project paths", async () => {
    const monthStart = new Date("2030-02-01T00:00:00.000Z");
    const dayStart = new Date("2030-02-02T00:00:00.000Z");
    const dayEnd = new Date("2030-02-03T00:00:00.000Z");
    const traceContent = (inputTokens: number, costUsd: number) =>
      JSON.stringify([
        {
          type: "result",
          content: "done",
          accounting: {
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              cacheReadTokens: 1,
              cacheWriteTokens: 2,
              inputTokens,
              outputTokens: 3,
            },
            costUsd,
          },
        },
      ]);

    await repo.createSession("sess-alpha-total", "Alpha", undefined, "alpha", null, "alpha");
    await repo.createSession("sess-null-total", "Legacy", undefined, "legacy", null, null);
    await repo.createSession("sess-other-total", "Other", undefined, "other", null, "other");
    await repo.addMessage("trace-alpha-total", "sess-alpha-total", "trace", traceContent(10, 0.1));
    await repo.addMessage("trace-null-total", "sess-null-total", "trace", traceContent(20, 0.2));
    await repo.addMessage("trace-other-total", "sess-other-total", "trace", traceContent(30, 0.3));

    for (const id of ["trace-alpha-total", "trace-null-total", "trace-other-total"]) {
      await testDb.db
        .update(romeAgentMessages)
        .set({ createdAt: new Date("2030-02-02T12:00:00.000Z") })
        .where(eq(romeAgentMessages.id, id));
    }

    const totals = await repo.getUsageTotals({
      dayRanges: [{ date: "2030-02-02", start: dayStart, end: dayEnd }],
      monthStart,
    });

    expect(totals.totalInputTokens).toBe(60);
    expect(totals.totalCacheReadTokens).toBe(3);
    expect(totals.totalCacheWriteTokens).toBe(6);
    expect(totals.totalTokens).toBe(78);
    expect(totals.totalCostUsd).toBeCloseTo(0.6);
    expect(totals.monthCostUsd).toBeCloseTo(0.6);
    expect(totals.monthTokens).toBe(78);
    expect(totals.days).toHaveLength(1);
    expect(totals.days[0]).toMatchObject({
      cacheReadTokens: 3,
      cacheWriteTokens: 6,
      date: "2030-02-02",
      inputTokens: 60,
      outputTokens: 9,
    });
    expect(totals.days[0]?.costUsd).toBeCloseTo(0.6);
  });

  describe("turn feedback", () => {
    beforeEach(async () => {
      await repo.createSession("sess-fb", "Feedback Session");
    });

    it("returns null when no feedback exists", async () => {
      await expect(repo.getTurnFeedback("sess-fb", "turn-1")).resolves.toBeNull();
    });

    it("inserts and reads back feedback", async () => {
      const stored = await repo.insertTurnFeedback("sess-fb", "turn-1", "negative", "wrong answer");
      expect(stored).toMatchObject({ rating: "negative", comment: "wrong answer" });
      const row = await repo.getTurnFeedback("sess-fb", "turn-1");
      expect(row).toMatchObject({ rating: "negative", comment: "wrong answer" });
      expect(row?.updatedAt).toBeInstanceOf(Date);
    });

    it("second insertTurnFeedback returns null and does not overwrite the first", async () => {
      // Write-once contract: ON CONFLICT DO NOTHING + composite PK means a
      // racing or stale second insert gets no row back. The route maps the
      // null return into a 409 so callers can't silently overwrite.
      const first = await repo.insertTurnFeedback("sess-fb", "turn-1", "negative", "first");
      expect(first).not.toBeNull();
      const second = await repo.insertTurnFeedback("sess-fb", "turn-1", "positive", "better");
      expect(second).toBeNull();

      const row = await repo.getTurnFeedback("sess-fb", "turn-1");
      expect(row).toMatchObject({ rating: "negative", comment: "first" });

      const all = (await testDb.db.all(sql`
        SELECT count(*) as c FROM webchat_turn_feedback
        WHERE session_id = 'sess-fb' AND turn_id = 'turn-1'
      `)) as Array<{ c: number }>;
      expect(all[0]?.c).toBe(1);
    });

    it("hasTurnInSession returns true only when a message with that turn lives in the session", async () => {
      await repo.createSession("sess-other-fb", "Other Feedback Session");
      await repo.addMessage("anchor-here", "sess-fb", "trace", "[]", "turn-here");
      await repo.addMessage("anchor-there", "sess-other-fb", "trace", "[]", "turn-there");

      await expect(repo.hasTurnInSession("sess-fb", "turn-here")).resolves.toBe(true);
      // turnId exists in the system but belongs to a different session.
      await expect(repo.hasTurnInSession("sess-fb", "turn-there")).resolves.toBe(false);
      // turnId never recorded for any session.
      await expect(repo.hasTurnInSession("sess-fb", "unknown-turn")).resolves.toBe(false);
    });

    it("cascades to feedback rows when the session is deleted", async () => {
      await repo.insertTurnFeedback("sess-fb", "turn-1", "positive", null);
      await repo.insertTurnFeedback("sess-fb", "turn-2", "negative", null);
      await repo.deleteSession("sess-fb");

      const remaining = (await testDb.db.all(sql`
        SELECT count(*) as c FROM webchat_turn_feedback WHERE session_id = 'sess-fb'
      `)) as Array<{ c: number }>;
      expect(remaining[0]?.c).toBe(0);
    });

    it("FK ON DELETE CASCADE clears feedback even when the explicit delete is bypassed", async () => {
      // Bypass deleteSession (which already issues an explicit feedback delete)
      // and delete the parent row directly. The DB-level cascade must clean
      // feedback rows by itself — this is the defense-in-depth guarantee.
      await repo.insertTurnFeedback("sess-fb", "turn-1", "negative", null);
      await testDb.db.delete(romeSessions).where(eq(romeSessions.id, "sess-fb"));
      await expect(repo.getTurnFeedback("sess-fb", "turn-1")).resolves.toBeNull();
    });

    it("deleteSession is atomic — a failure inside the transaction rolls back all three deletes", async () => {
      // Stub the underlying transaction so the third delete throws. The
      // session row must still exist (transaction rolls back), and the
      // feedback row must remain — guarding against the previously-reported
      // partial-failure leak where messages got deleted but the session row
      // survived.
      await repo.insertTurnFeedback("sess-fb", "turn-1", "negative", "draft");
      await repo.addMessage("msg-1", "sess-fb", "user", "[]", "turn-1");

      const original = testDb.db.transaction.bind(testDb.db);
      const spy = rs
        .spyOn(testDb.db, "transaction")
        .mockImplementation((cb: Parameters<typeof original>[0]) =>
          original((tx) => {
            // Inject a failure mid-transaction.
            cb(tx);
            throw new Error("simulated mid-transaction failure");
          }),
        );

      await expect(repo.deleteSession("sess-fb")).rejects.toThrow(/simulated/);
      spy.mockRestore();

      const session = await repo.getSession("sess-fb");
      expect(session).not.toBeNull();
      const feedback = await repo.getTurnFeedback("sess-fb", "turn-1");
      expect(feedback).not.toBeNull();
    });
  });
});
