// The dashboard chat is a channel Rome serves itself, with no Connection
// behind it (docs/domains/connections.md#connection).

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { WEBCHAT_SURFACE, webchatChannel } from "./webchat-channel.js";

describe("webchat channel", () => {
  let testDb: TestDb;
  let repo: WebChatRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new WebChatRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("stores a sent message in its chat", async () => {
    await repo.createSession("sess-1", "Test Session");

    const receipt = await webchatChannel(repo).send!.send("sess-1" as ChatId, {
      text: "hello from the agent",
    });

    const rows = await repo.getHistoryMessages("sess-1", new Date(0));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain("hello from the agent");
    expect(receipt).toStrictEqual({ chatId: "sess-1", messageId: rows[0]!.id });
  });

  it("answers what was said newest first, as the channel's record", async () => {
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

    const history = await webchatChannel(repo).messages!.query({ chatId: "sess-3" as ChatId });

    const rows = await repo.getHistoryMessages("sess-3", new Date(0));
    expect(history.map((message) => message.messageId)).toEqual(["msg-agent", "msg-guardian"]);
    expect(history[1]).toStrictEqual({
      channel: "webchat",
      direction: "inbound",
      messageId: "msg-guardian",
      chatId: "sess-3",
      senderId: "guardian",
      senderDisplayName: "Guardian",
      text: "Draft the plan",
      attachments: [],
      timestamp: rows[0]!.createdAt,
      thread: { kind: "dm", name: "Planner Session" },
      raw: rows[0],
    });
    expect(history[0]).toMatchObject({
      direction: "outbound",
      senderId: "workflow-planner",
      senderDisplayName: "Workflow Planner",
    });
  });

  it("caps what it answers at the query's limit", async () => {
    await repo.createSession("sess-4", "Limit Session");
    for (const id of ["msg-a", "msg-b", "msg-c"]) {
      await repo.addMessage(id, "sess-4", "user", JSON.stringify([{ type: "text", content: id }]));
    }

    const history = await webchatChannel(repo).messages!.query({
      chatId: "sess-4" as ChatId,
      limit: 2,
    });

    expect(history).toHaveLength(2);
  });

  it("hears nothing through a port, and renders cards with no prompt context", () => {
    const channel = webchatChannel(repo);
    expect(channel.inbound).toBeNull();
    expect(WEBCHAT_SURFACE).toEqual({ interactiveCards: true, promptContext: false });
  });
});
