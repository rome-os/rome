import { describe, it, expect, afterEach } from "@rstest/core";
import { sql } from "drizzle-orm";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import {
  createTestDb,
  createMockAgentRunner,
  buildMessage,
  buildAgentConfig,
  FakeTransport,
  MockModelProvider,
  type TestDb,
} from "./helpers.js";

describe("Test Helpers", () => {
  let testDb: TestDb;

  afterEach(() => {
    testDb?.close();
  });

  describe("createTestDb", () => {
    it("creates an in-memory SQLite database with all tables", () => {
      testDb = createTestDb();
      expect(testDb.db).toBeDefined();
      expect(testDb.close).toBeInstanceOf(Function);
    });

    it("has all expected tables", () => {
      testDb = createTestDb();
      const { db } = testDb;

      // Query sqlite_master for all tables created
      const result = db.all(sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
      const tableNames = result.map((row) => (row as Record<string, unknown>).name);

      expect(tableNames).toContain("sessions");
      expect(tableNames).toContain("persons");
      expect(tableNames).toContain("channel_mappings");
      expect(tableNames).toContain("sentinel_log");
      expect(tableNames).toContain("approvals");
      expect(tableNames).toContain("settings");
      expect(tableNames).toContain("policies");
      expect(tableNames).toContain("guardian_auth");
    });
  });

  describe("buildMessage", () => {
    it("returns an inbound ChannelMessage with defaults", () => {
      const msg = buildMessage();
      expect(msg.messageId).toBe("msg-001");
      expect(msg.channel).toBe("telegram");
      expect(msg.direction).toBe("inbound");
      expect(msg.senderId).toBe("user-123");
      expect(msg.senderDisplayName).toBe("Test User");
      expect(msg.conversationId).toBe("thread-001");
      expect(msg.thread).toEqual({ kind: "dm" });
      expect(msg.text).toBe("Hello, world!");
      expect(msg.attachments).toEqual([]);
    });

    it("allows overriding fields", () => {
      const msg = buildMessage({
        channel: "whatsapp",
        text: "Custom text",
        thread: { kind: "group" },
      });
      expect(msg.channel).toBe("whatsapp");
      expect(msg.text).toBe("Custom text");
      expect(msg.thread).toEqual({ kind: "group" });
      // defaults still apply for non-overridden fields
      expect(msg.messageId).toBe("msg-001");
    });
  });

  describe("buildAgentConfig", () => {
    it("returns an AgentConfig with defaults", () => {
      const config = buildAgentConfig();
      expect(config.name).toBe("test-agent");
      expect(config.tier).toBe("small");
      expect(config.reasoningEffort).toBe("high");
      expect(config.tools).toEqual([]);
      expect(config.permissionMode).toBe("default");
    });

    it("allows overriding fields", () => {
      const config = buildAgentConfig({
        name: "custom",
        tier: "large",
        tools: ["Read", "Edit"],
      });
      expect(config.name).toBe("custom");
      expect(config.tier).toBe("large");
      expect(config.tools).toEqual(["Read", "Edit"]);
    });
  });

  describe("MockModelProvider", () => {
    it("yields predetermined responses", async () => {
      const provider = new MockModelProvider([
        [
          { type: "text", content: "Hello" },
          { type: "result", content: "Done" },
        ],
      ]);

      const messages: unknown[] = [];
      for await (const msg of provider.run({
        model: "test",
        systemPrompt: "test",
        prompt: "test",
        actionCatalog: [],
        skillCatalog: [],
        subagentTools: [],
        executeAction: async () => ({}),
        executeSubagent: async () => ({}),
      })) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ type: "text", content: "Hello" });
      expect(messages[1]).toEqual({ type: "result", content: "Done" });
    });

    it("tracks calls", async () => {
      const provider = new MockModelProvider([[]]);
      const params = {
        model: "test-model",
        systemPrompt: "sys",
        prompt: "user prompt",
        actionCatalog: [],
        skillCatalog: [],
        subagentTools: [],
        executeAction: async () => ({}),
        executeSubagent: async () => ({}),
      };

      // consume the iterator
      for await (const _ of provider.run(params)) {
        // no-op
      }

      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].model).toBe("test-model");
    });
  });

  describe("FakeTransport", () => {
    it("captures sent messages and answers each with a receipt", async () => {
      const transport = new FakeTransport("telegram");
      expect(transport.channel).toBe("telegram");

      const receipt = await transport.send("thread-1" as ConversationId, { text: "Hi" });
      expect(receipt.conversationId).toBe("thread-1");
      expect(receipt.messageId).toEqual(expect.any(String));
      expect(transport.sentMessages).toEqual([
        { conversationId: "thread-1", message: { text: "Hi" } },
      ]);
    });

    it("delivers a received message, named for its channel, to every listener", async () => {
      const transport = new FakeTransport("discord");
      const received: ChannelMessage[] = [];
      transport.listen(async (msg) => {
        received.push(msg);
      });

      const msg = await transport.receive({ text: "ping" });

      expect(msg).toMatchObject({ channel: "discord", direction: "inbound", text: "ping" });
      expect(received).toEqual([msg]);
    });
  });

  describe("createMockAgentRunner", () => {
    it("yields predetermined responses and tracks calls", async () => {
      const runner = createMockAgentRunner([
        [
          { type: "session_init", sessionId: "sess-1" },
          { type: "result", content: "OK" },
        ],
      ]);

      const messages: unknown[] = [];
      for await (const msg of runner.run({
        agentName: "test",
        prompt: "hello",
      })) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0].agentName).toBe("test");
    });
  });
});
