import { describe, it, expect, afterEach } from "@rstest/core";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  createMockAgentRunner,
  createMockChannel,
  buildMessage,
  buildAgentConfig,
  MockModelProvider,
  MockProviderAdapter,
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

      expect(tableNames).toContain("events");
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
    it("returns a NormalizedMessage with defaults", () => {
      const msg = buildMessage();
      expect(msg.id).toBe("msg-001");
      expect(msg.channel).toBe("telegram");
      expect(msg.channelUserId).toBe("user-123");
      expect(msg.displayName).toBe("Test User");
      expect(msg.threadId).toBe("thread-001");
      expect(msg.threadType).toBe("private");
      expect(msg.text).toBe("Hello, world!");
      expect(msg.attachments).toEqual([]);
    });

    it("allows overriding fields", () => {
      const msg = buildMessage({
        channel: "whatsapp",
        text: "Custom text",
        threadType: "group",
      });
      expect(msg.channel).toBe("whatsapp");
      expect(msg.text).toBe("Custom text");
      expect(msg.threadType).toBe("group");
      // defaults still apply for non-overridden fields
      expect(msg.id).toBe("msg-001");
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

  describe("MockProviderAdapter", () => {
    it("captures sent messages", async () => {
      const adapter = new MockProviderAdapter("telegram");
      expect(adapter.channelName).toBe("telegram");

      await adapter.sendMessage("user-1", "thread-1", { text: "Hi" });
      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]).toEqual({
        channelUserId: "user-1",
        threadId: "thread-1",
        message: { text: "Hi" },
      });
    });

    it("delivers simulated messages to handler", async () => {
      const adapter = new MockProviderAdapter();
      const received: unknown[] = [];

      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      const msg = buildMessage();
      await adapter.simulateMessage(msg);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(msg);
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

  describe("createMockChannel", () => {
    it("returns a MockProviderAdapter", () => {
      const channel = createMockChannel("whatsapp");
      expect(channel).toBeInstanceOf(MockProviderAdapter);
      expect(channel.channelName).toBe("whatsapp");
    });
  });
});
