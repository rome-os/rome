import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { readWebchatMessages, WebChatAdapter } from "./webchat.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { WebChatRepository } from "../../db/repositories/webchat.js";
import { ChatsWebChatRepository } from "../../webchat/chats-webchat-repository.js";

/** The instant `hours` before the test's fixed clock. */
function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

describe("WebChatAdapter", () => {
  let testDb: TestDb;
  let repo: WebChatRepository;
  let adapter: WebChatAdapter;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new ChatsWebChatRepository(testDb.db);
    adapter = new WebChatAdapter(repo);
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2030-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    rs.useRealTimers();
    testDb.close();
  });

  it("fetches recent user and assistant history from one webchat session", async () => {
    rs.setSystemTime(new Date("2029-12-31T12:00:00.000Z"));
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
      "msg-old",
      "sess-1",
      "user",
      JSON.stringify([{ type: "text", content: "Old context" }]),
    );
    rs.setSystemTime(new Date("2030-01-01T12:00:00.000Z"));
    await repo.addMessage(
      "msg-user",
      "sess-1",
      "user",
      JSON.stringify([{ type: "text", content: "Please draft the plan." }]),
    );
    rs.setSystemTime(new Date("2030-01-01T12:00:01.000Z"));
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

    const messages = await readWebchatMessages(repo, "sess-1", hoursAgo(2));

    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.messageId)).toEqual(["msg-user", "msg-assistant"]);
    expect(messages[0]).toStrictEqual({
      channel: "webchat",
      direction: "inbound",
      messageId: "msg-user",
      chatId: "sess-1",
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
      chatId: "sess-1",
      thread: { kind: "dm", name: "Build Planner" },
      text: "Working on it.\nPlan draft complete.",
    });
  });

  it("fetches all session history chronologically when threadId is null", async () => {
    rs.setSystemTime(new Date("2030-01-01T10:00:00.000Z"));
    await repo.createSession("sess-a", "Alpha");
    await repo.createSession("sess-b", "Beta");
    rs.setSystemTime(new Date("2030-01-01T11:30:00.000Z"));
    await repo.addMessage(
      "msg-b",
      "sess-b",
      "user",
      JSON.stringify([{ type: "text", content: "Second session" }]),
    );
    rs.setSystemTime(new Date("2030-01-01T11:00:00.000Z"));
    await repo.addMessage(
      "msg-a",
      "sess-a",
      "assistant",
      JSON.stringify([{ type: "text", content: "First session" }]),
    );
    rs.setSystemTime(new Date("2030-01-01T12:00:00.000Z"));

    const messages = await readWebchatMessages(repo, null, hoursAgo(24));

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

    await expect(readWebchatMessages(repo, null, hoursAgo(24))).resolves.toEqual([
      expect.objectContaining({ messageId: "msg-parent", chatId: "sess-parent" }),
    ]);
    await expect(readWebchatMessages(repo, "sess-child", hoursAgo(24))).resolves.toEqual([
      expect.objectContaining({
        messageId: "msg-child",
        chatId: "sess-child",
        text: "Hidden specialist context",
      }),
    ]);
  });

  it("persists the WebChat text-block identity in transcript content", async () => {
    await repo.createSession("sess-block", "Block identity");

    const receipt = await adapter.send("sess-block" as ChatId, {
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
    expect(receipt).toStrictEqual({ chatId: "sess-block", messageId: messages[0]?.id });
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
  it("refuses routine_draft_card parts a sender supplies, and persists nothing", async () => {
    await repo.createSession("sess-forged", "Forged card");

    const forged = adapter.send("sess-forged" as ChatId, {
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
    const cardOnly = adapter.send("sess-forged" as ChatId, {
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

    for (const send of [forged, cardOnly]) {
      await expect(send).rejects.toMatchObject({
        name: "ChannelSendRefused",
        reason: "part_unsupported",
      });
    }
    await expect(repo.getMessages("sess-forged")).resolves.toEqual([]);
  });

  it("refuses a message with nothing to persist", async () => {
    await repo.createSession("sess-empty", "Empty");

    for (const blank of [
      {},
      { text: "   " },
      { parts: [{ type: "text" as const, content: "" }] },
    ]) {
      await expect(adapter.send("sess-empty" as ChatId, blank)).rejects.toMatchObject({
        name: "ChannelSendRefused",
        reason: "empty",
      });
    }
    await expect(repo.getMessages("sess-empty")).resolves.toEqual([]);
  });
});
