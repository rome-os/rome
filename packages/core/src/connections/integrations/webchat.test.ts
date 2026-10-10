// The WebChat descriptor. WebChat is the zero-grant case
//: Talk unlocks from birth with no confer/import step, and
// never faults (in-process, no external transport). Coverage:
//   1. descriptor shape — zero grants, a talker needing none.
//   2. registry-level: connect() unlocks talk immediately.
//   3. send and history round-trip through the wrapped WebChatAdapter.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { sendThrough } from "../../channels/connection-ports.js";
import type { ConversationId } from "@rome-os/app-runtime";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { ConnectionRegistry } from "../registry.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { WebChatRepository } from "../../db/repositories/webchat.js";
import { makeWebchatDescriptor } from "./webchat.js";

// A fresh drizzle-backed ledger per test (InMemoryGrantLedger left with p1);
// opened DBs are closed after each test.
const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});
function makeLedger(): DrizzleGrantLedger {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleGrantLedger(db);
}

describe("webchat descriptor shape", () => {
  it("declares zero grants and a talker needing none", () => {
    const testDb = createTestDb();
    const repo = new WebChatRepository(testDb.db);
    const desc = makeWebchatDescriptor({ webchatRepo: repo });
    expect(desc.service).toBe("webchat");
    expect(Object.keys(desc.auth)).toEqual([]);
    expect(desc.capabilities.talker?.needs).toEqual([]);
    expect(desc.capabilities.actor).toBeUndefined();
    expect(desc.capabilities.watcher).toBeUndefined();
    testDb.close();
  });
});

describe("webchat descriptor over a real ConnectionRegistry", () => {
  let testDb: TestDb;
  let repo: WebChatRepository;
  let registry: ConnectionRegistry;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new WebChatRepository(testDb.db);
    registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeWebchatDescriptor({ webchatRepo: repo }));
  });

  afterEach(() => {
    testDb.close();
  });

  it("unlocks talk immediately on connect() — no grant to confer", async () => {
    const conn = await registry.connect("webchat");
    expect(conn.status().talk).toEqual({ state: "unlocked" });
    expect(conn.isUnlocked("talk")).toBe(true);
  });

  it("fires onUnlocked for a connection that already existed before the handler registered", async () => {
    const conn = await registry.connect("webchat");
    const unlocked: string[] = [];
    registry.onUnlocked("talk", (c) => unlocked.push(c.id));
    expect(unlocked).toEqual([conn.id]);
  });

  it("round-trips send() through the wrapped WebChatAdapter into the repo", async () => {
    await repo.createSession("sess-1", "Test Session");
    const conn = await registry.connect("webchat");
    const receipt = await sendThrough(conn, "sess-1" as ConversationId, {
      text: "hello from talk",
    });

    const rows = await repo.getHistoryMessages("sess-1", new Date(0));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("hello from talk");
    expect(receipt).toStrictEqual({ conversationId: "sess-1", messageId: rows[0].id });
  });

  // The flag is what gives the channel a \`messages\` port; the feature is what
  // answers it. A Talk offering one without the other is unreachable or broken.
  it("declares the history its Talk offers", () => {
    expect(makeWebchatDescriptor({ webchatRepo: {} as never }).capabilities.talker?.history).toBe(
      true,
    );
  });

  it("declares a surface that renders cards and needs no prompt context", () => {
    const talker = makeWebchatDescriptor({ webchatRepo: {} as never }).capabilities.talker;
    expect(talker?.interactiveCards).toBe(true);
    expect(talker?.promptContext).toBe(false);
  });

  it("forwards history to the wrapped adapter", async () => {
    await repo.createSession("sess-2", "History Session");
    await repo.addMessage(
      "msg-1",
      "sess-2",
      "user",
      JSON.stringify([{ type: "text", content: "Hi there" }]),
    );
    const conn = await registry.connect("webchat");
    const history = await conn.withTalker((talker) =>
      talker.history?.query({
        conversationId: "sess-2" as ConversationId,
        limit: 20,
      }),
    );
    expect(history).toHaveLength(1);
    expect(history?.[0]).toMatchObject({
      conversationId: "sess-2",
      senderId: "guardian",
      text: "Hi there",
    });
  });

  it("answers history as the channel's record, field by field", async () => {
    await repo.createSession(
      "sess-3",
      "Planner Session",
      undefined,
      "default",
      null,
      "default",
      "workflow-planner",
    );
    await repo.addMessage(
      "msg-guardian",
      "sess-3",
      "user",
      JSON.stringify([{ type: "text", content: "Draft the plan" }]),
    );
    await repo.addMessage(
      "msg-agent",
      "sess-3",
      "assistant",
      JSON.stringify([{ type: "text", content: "Plan drafted" }]),
    );
    const conn = await registry.connect("webchat");
    const history = await conn.withTalker((talker) =>
      talker.history?.query({ conversationId: "sess-3" as ConversationId }),
    );

    const rows = await repo.getHistoryMessages("sess-3", new Date(0));
    expect(history).toStrictEqual([
      {
        channel: "webchat",
        direction: "inbound",
        messageId: "msg-guardian",
        conversationId: "sess-3",
        senderId: "guardian",
        senderDisplayName: "Guardian",
        text: "Draft the plan",
        attachments: [],
        timestamp: rows[0].createdAt,
        thread: { kind: "dm", name: "Planner Session" },
        raw: rows[0],
      },
      {
        channel: "webchat",
        direction: "outbound",
        messageId: "msg-agent",
        conversationId: "sess-3",
        senderId: "workflow-planner",
        senderDisplayName: "Workflow Planner",
        text: "Plan drafted",
        attachments: [],
        timestamp: rows[1].createdAt,
        thread: { kind: "dm", name: "Planner Session" },
        raw: rows[1],
      },
    ]);
  });

  it("caps history at the query's limit", async () => {
    await repo.createSession("sess-4", "Limit Session");
    for (const id of ["msg-a", "msg-b", "msg-c"]) {
      await repo.addMessage(id, "sess-4", "user", JSON.stringify([{ type: "text", content: id }]));
    }
    const conn = await registry.connect("webchat");

    const history = await conn.withTalker((talker) =>
      talker.history?.query({ conversationId: "sess-4" as ConversationId, limit: 2 }),
    );
    expect(history).toHaveLength(2);
  });

  it("never reports a fault (in-process, no transport)", async () => {
    const conn = await registry.connect("webchat");
    // If start() ever routed a synchronous throw into fault, the connection
    // would relock — assert it stays unlocked well past a macrotask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conn.status().talk).toEqual({ state: "unlocked" });
  });
});
