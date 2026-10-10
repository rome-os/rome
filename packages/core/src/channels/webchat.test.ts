import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import { eq } from "drizzle-orm";
import { WebChatAdapter } from "./webchat.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { romeAgentMessages } from "../db/schema.js";
import { WebChatRepository } from "../db/repositories/webchat.js";

describe("WebChatAdapter", () => {
  let testDb: TestDb;
  let repo: WebChatRepository;
  let adapter: WebChatAdapter;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new WebChatRepository(testDb.db);
    adapter = new WebChatAdapter(repo);
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2030-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    rs.useRealTimers();
    testDb.close();
  });

  it("fetches recent user and assistant history from one webchat session", async () => {
    await repo.createSession(
      "sess-1",
      "Build Planner",
      undefined,
      "default",
      null,
      "default",
      "workflow-planner",
    );
    await repo.addMessage(
      "msg-user",
      "sess-1",
      "user",
      JSON.stringify([{ type: "text", content: "Please draft the plan." }]),
    );
    await repo.addMessage(
      "msg-assistant",
      "sess-1",
      "assistant",
      JSON.stringify([
        { type: "text", content: "Working on it.", turnPhase: "commentary" },
        { type: "turn_recap", turnId: "turn-1", content: "Plan draft complete." },
      ]),
    );
    await repo.addMessage(
      "msg-card-only",
      "sess-1",
      "assistant",
      JSON.stringify([{ type: "approval_card", approvalId: "appr-1" }]),
    );
    await repo.addMessage("msg-trace", "sess-1", "trace", "[]");
    await repo.addMessage(
      "msg-old",
      "sess-1",
      "user",
      JSON.stringify([{ type: "text", content: "Old context" }]),
    );
    await testDb.db
      .update(romeAgentMessages)
      .set({ createdAt: new Date("2030-01-01T00:00:00.000Z") })
      .where(eq(romeAgentMessages.id, "msg-old"));

    const messages = await adapter.fetchHistory("sess-1", 2);

    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.messageId)).toEqual(["msg-user", "msg-assistant"]);
    expect(messages[0]).toStrictEqual({
      channel: "webchat",
      direction: "inbound",
      messageId: "msg-user",
      conversationId: "sess-1",
      senderId: "guardian",
      senderDisplayName: "Guardian",
      text: "Please draft the plan.",
      attachments: [],
      timestamp: expect.any(Date),
      thread: { kind: "dm", name: "Build Planner" },
      raw: expect.objectContaining({ id: "msg-user", role: "user", sessionId: "sess-1" }),
    });
    expect(messages[1]).toMatchObject({
      direction: "outbound",
      senderId: "workflow-planner",
      senderDisplayName: "Workflow Planner",
      conversationId: "sess-1",
      thread: { kind: "dm", name: "Build Planner" },
      text: "Working on it.\nPlan draft complete.",
    });
  });

  it("fetches all session history chronologically when threadId is null", async () => {
    await repo.createSession("sess-a", "Alpha");
    await repo.createSession("sess-b", "Beta");
    await repo.addMessage(
      "msg-b",
      "sess-b",
      "user",
      JSON.stringify([{ type: "text", content: "Second session" }]),
    );
    await repo.addMessage(
      "msg-a",
      "sess-a",
      "assistant",
      JSON.stringify([{ type: "text", content: "First session" }]),
    );
    await testDb.db
      .update(romeAgentMessages)
      .set({ createdAt: new Date("2030-01-01T11:00:00.000Z") })
      .where(eq(romeAgentMessages.id, "msg-a"));
    await testDb.db
      .update(romeAgentMessages)
      .set({ createdAt: new Date("2030-01-01T11:30:00.000Z") })
      .where(eq(romeAgentMessages.id, "msg-b"));

    const messages = await adapter.fetchHistory(null, 24);

    expect(messages.map((m) => [m.messageId, m.thread?.name, m.text])).toEqual([
      ["msg-a", "Alpha", "First session"],
      ["msg-b", "Beta", "Second session"],
    ]);
  });

  it("hides handoff child sessions from all-session history but allows explicit lookup", async () => {
    await repo.createSession("sess-parent", "Parent");
    await repo.createSession(
      "sess-child",
      "Specialist",
      undefined,
      "default",
      null,
      "default",
      "specialist-agent",
      "webchat_handoff",
    );
    await repo.addMessage(
      "msg-parent",
      "sess-parent",
      "user",
      JSON.stringify([{ type: "text", content: "Top-level context" }]),
    );
    await repo.addMessage(
      "msg-child",
      "sess-child",
      "assistant",
      JSON.stringify([{ type: "text", content: "Hidden specialist context" }]),
    );

    await expect(adapter.fetchHistory(null, 24)).resolves.toEqual([
      expect.objectContaining({ messageId: "msg-parent", conversationId: "sess-parent" }),
    ]);
    await expect(adapter.fetchHistory("sess-child", 24)).resolves.toEqual([
      expect.objectContaining({
        messageId: "msg-child",
        conversationId: "sess-child",
        text: "Hidden specialist context",
      }),
    ]);
  });

  it("falls back to the default history window for invalid windowHours", async () => {
    await repo.createSession("sess-1", "Fallback");
    await repo.addMessage(
      "msg-recent",
      "sess-1",
      "user",
      JSON.stringify([{ type: "text", content: "Recent" }]),
    );

    await expect(adapter.fetchHistory("sess-1", Number.NaN)).resolves.toHaveLength(1);
  });

  it("persists the WebChat text-block identity in transcript content", async () => {
    await repo.createSession("sess-block", "Block identity");

    const receipt = await adapter.send("sess-block" as ConversationId, {
      text: "Final answer",
      parts: [
        {
          type: "text",
          content: "Final answer",
          turnPhase: "final",
          blockIx: 2,
        },
      ],
      turnId: "turn-block",
    });

    const messages = await repo.getMessages("sess-block");
    expect(receipt).toStrictEqual({ conversationId: "sess-block", messageId: messages[0]?.id });
    expect(messages).toEqual([
      expect.objectContaining({
        turnId: "turn-block",
        role: "assistant",
        content: JSON.stringify([
          {
            type: "text",
            content: "Final answer",
            turnPhase: "final",
            blockIx: 2,
          },
        ]),
      }),
    ]);
  });

  // Routine cards carry routine controls, so only the webchat drain writes them.
  it("drops routine_draft_card parts a sender supplies", async () => {
    await repo.createSession("sess-forged", "Forged card");

    await adapter.send("sess-forged" as ConversationId, {
      text: "fallback",
      parts: [
        {
          type: "routine_draft_card",
          toolUseId: "tu-forged",
          routineKey: "chat-routine:someone-elses",
          draft: {
            sentence: "Harmless check",
            name: "Harmless check",
            watchLabel: "Run on demand",
            thenSummary: "nothing",
            trigger: { type: "manual" },
            actionName: "summon",
            args: {},
          },
        },
        { type: "text", content: "Hello" },
      ],
    });
    await adapter.send("sess-forged" as ConversationId, {
      text: "Only a card was sent",
      parts: [
        {
          type: "routine_draft_card",
          toolUseId: "tu-forged-2",
          draft: {
            sentence: "x",
            name: "x",
            watchLabel: "x",
            thenSummary: "x",
            trigger: { type: "manual" },
            actionName: "summon",
            args: {},
          },
        },
      ],
    });

    const contents = (await repo.getMessages("sess-forged")).map((m) => JSON.parse(m.content));
    // Same-second rows have no guaranteed order.
    expect(contents).toHaveLength(2);
    expect(contents).toEqual(
      expect.arrayContaining([
        [{ type: "text", content: "Hello" }],
        [{ type: "text", content: "Only a card was sent" }],
      ]),
    );
  });

  it("returns a receipt without a messageId when there is nothing to persist", async () => {
    await repo.createSession("sess-empty", "Empty");

    await expect(adapter.send("sess-empty" as ConversationId, {})).resolves.toStrictEqual({
      conversationId: "sess-empty",
    });
    await expect(repo.getMessages("sess-empty")).resolves.toEqual([]);
  });
});
