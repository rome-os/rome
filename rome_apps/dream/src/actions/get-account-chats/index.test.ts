import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, it, expect } from "@rstest/core";
import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../../../../../packages/core/src/test/helpers.js";
import { createAction } from "./index.js";

const actionConfig = {
  name: "get_account_chats",
  type: "custom",
  description: "Fetch recent chats from every one of Rome's accounts",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
} as const;

function makeDeps(rows: unknown[]): AppActionRuntimeDeps {
  return {
    appContext: {
      db: {
        connection: {
          all: () => rows,
        },
      },
    },
  } as unknown as AppActionRuntimeDeps;
}

function row(overrides: Record<string, unknown>) {
  return {
    session_id: "s1",
    session_name: "Chat",
    thread_name: null,
    channel: "telegram",
    service: "telegram",
    platform: "telegram",
    role: "user",
    sender_name: "Alice",
    sender_id: "100",
    content: "hello",
    created_at: 1700000000,
    ...overrides,
  };
}

describe("get_account_chats", () => {
  it("groups chats under the account that carried them, naming the platform", async () => {
    const rows = [
      row({ session_id: "s1", thread_name: "Team group", content: "ship it" }),
      row({ session_id: "s1", thread_name: "Team group", role: "assistant", content: "done" }),
      row({
        session_id: "s2",
        channel: "c7f3a1",
        service: "discord",
        platform: "discord",
        thread_name: "general",
        sender_name: "Bob",
        content: "from the second account",
      }),
    ];

    const result = await createAction(actionConfig, makeDeps(rows)).execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { messageCount: number; content: string };
    expect(data.messageCount).toBe(3);
    expect(data.content).toContain("### Telegram account `telegram`");
    expect(data.content).toContain("#### Chat: Team group");
    expect(data.content).toContain("**Alice**: ship it");
    expect(data.content).toContain("**Agent**: done");
    expect(data.content).toContain("### Discord account `c7f3a1`");
    expect(data.content).toContain("**Bob**: from the second account");
  });

  it("names the service when it differs from the platform", async () => {
    const rows = [row({ channel: "telegram_user", service: "telegram_user" })];

    const result = await createAction(actionConfig, makeDeps(rows)).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { content: string };
    expect(data.content).toContain("### Telegram account `telegram_user` (telegram_user)");
  });

  it("falls back to the channel id when the account's channel row is gone", async () => {
    const rows = [row({ channel: "feishu", service: null, platform: null })];

    const result = await createAction(actionConfig, makeDeps(rows)).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect((result.data as { content: string }).content).toContain("### Feishu account `feishu`");
  });

  it("returns an empty message when no rows are found", async () => {
    const result = await createAction(actionConfig, makeDeps([])).execute({});

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect((result.data as { content: string }).content).toContain(
      "(No chats on Rome's accounts in the requested window.)",
    );
  });

  it("returns an error when the query fails", async () => {
    const deps = {
      appContext: {
        db: {
          connection: {
            all: () => {
              throw new Error("db locked");
            },
          },
        },
      },
    } as unknown as AppActionRuntimeDeps;

    const result = await createAction(actionConfig, deps).execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("db locked");
  });
});

describe("get_account_chats against the system schema", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  function realDeps(): AppActionRuntimeDeps {
    return { appContext: { db: { connection: testDb.db } } } as unknown as AppActionRuntimeDeps;
  }

  function seedChannel(id: string, service: string, platform: string): void {
    testDb.db.run(sql`
      INSERT INTO channels (id, service, platform, created_at)
      VALUES (${id}, ${service}, ${platform}, ${Math.floor(Date.now() / 1000)})
    `);
  }

  function seedSession(
    id: string,
    type: string,
    sourceChannel: string | null,
    threadName: string | null,
    createdAt: number,
  ): void {
    testDb.db.run(sql`
      INSERT INTO rome_sessions
        (id, name, type, source_channel, source_thread_id, source_thread_name, created_at, activity_at)
      VALUES
        (${id}, ${id}, ${type}, ${sourceChannel}, ${id}, ${threadName}, ${createdAt}, ${createdAt})
    `);
  }

  function seedMessage(
    id: string,
    sessionId: string,
    role: string,
    value: string,
    createdAt: number,
    senderName: string | null = null,
  ): void {
    testDb.db.run(sql`
      INSERT INTO rome_agent_messages (id, session_id, role, content, sender_name, created_at)
      VALUES (${id}, ${sessionId}, ${role}, ${JSON.stringify([{ type: "text", content: value }])}, ${senderName}, ${createdAt})
    `);
  }

  it("reads every account's chats, and not the dashboard's chats or background runs", async () => {
    const now = Math.floor(Date.now() / 1000);
    seedChannel("telegram", "telegram", "telegram");
    seedChannel("telegram_user", "telegram_user", "telegram");
    seedChannel("discord", "discord", "discord");
    seedChannel("d-second", "discord", "discord");
    seedChannel("feishu", "feishu", "feishu");
    seedSession("tg", "channel", "telegram", "Telegram DM", now - 60);
    seedSession("tgu", "channel", "telegram_user", "Friend", now - 60);
    seedSession("dc1", "channel", "discord", "general", now - 60);
    seedSession("dc2", "channel", "d-second", "support", now - 60);
    seedSession("fs", "channel", "feishu", "Team group", now - 60);
    seedSession("web", "channel", "webchat", null, now - 60);
    seedSession("bg", "action", null, null, now - 60);
    seedMessage("m1", "tg", "user", "telegram line", now - 50, "Alice");
    seedMessage("m2", "tgu", "user", "signed-in line", now - 50, "Friend");
    seedMessage("m3", "dc1", "user", "first discord line", now - 50, "Bob");
    seedMessage("m4", "dc2", "user", "second discord line", now - 50, "Carol");
    seedMessage("m5", "dc2", "assistant", "second discord answer", now - 45);
    seedMessage("m6", "fs", "user", "feishu line", now - 50, "Dan");
    seedMessage("m7", "fs", "trace", "trace text", now - 40);
    seedMessage("m8", "fs", "notification", "notification text", now - 40);
    seedMessage("m9", "web", "user", "dashboard line", now - 50);
    seedMessage("m10", "bg", "user", "dream prompt", now - 50);
    seedMessage("m11", "tg", "user", "too old", now - 3 * 60 * 60, "Alice");

    const result = await createAction(actionConfig, realDeps()).execute({ windowHours: 1 });

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const data = result.data as { messageCount: number; content: string };
    expect(data.messageCount).toBe(6);
    expect(data.content).toContain("### Telegram account `telegram`");
    expect(data.content).toContain("**Alice**: telegram line");
    expect(data.content).toContain("### Telegram account `telegram_user` (telegram_user)");
    expect(data.content).toContain("**Friend**: signed-in line");
    expect(data.content).toContain("### Discord account `discord`");
    expect(data.content).toContain("**Bob**: first discord line");
    expect(data.content).toContain("### Discord account `d-second`");
    expect(data.content).toContain("#### Chat: support");
    expect(data.content).toContain("**Carol**: second discord line");
    expect(data.content).toContain("**Agent**: second discord answer");
    expect(data.content).toContain("### Feishu account `feishu`");
    expect(data.content).toContain("**Dan**: feishu line");
    expect(data.content).not.toContain("trace text");
    expect(data.content).not.toContain("notification text");
    expect(data.content).not.toContain("dashboard line");
    expect(data.content).not.toContain("dream prompt");
    expect(data.content).not.toContain("too old");
  });
});
