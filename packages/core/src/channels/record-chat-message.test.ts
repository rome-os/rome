import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChatId, PolicyRule } from "@rome-os/app-runtime";
import { eq } from "drizzle-orm";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { romeAgentMessages, romeSessions } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { appendAttachmentPathsToPrompt as inboxAppendAttachmentPaths } from "../../../../rome_apps/inbox/src/actions/message-handler/index.js";
import { appendAttachmentPathsToPrompt, createChatMessageRecorder } from "./record-chat-message.js";

const REF = { connectionId: "connection:feishu", chatId: "group-1" as ChatId };

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channel: "feishu",
    direction: "inbound",
    messageId: "om-1",
    chatId: "group-1" as ChatId,
    senderId: "ou-alice",
    senderDisplayName: "Alice",
    text: "lunch at noon?",
    attachments: [],
    timestamp: new Date("2026-10-20T12:00:00Z"),
    thread: { kind: "group", name: "Team" },
    addressing: "ambient",
    ...overrides,
  };
}

describe("createChatMessageRecorder", () => {
  let testDb: TestDb;
  let chats: WebChatRepository;
  let person: { id: string; bondLevel: string } | null;
  let policy: PolicyRule;
  let loaded: Set<string>;
  const evaluatePolicy = rs.fn(async () => policy);
  const record = () =>
    createChatMessageRecorder({
      findPerson: async () => person,
      evaluatePolicy,
      chats,
      hasAgent: (name) => loaded.has(name),
    });

  const sessions = () => testDb.db.select().from(romeSessions);
  const rows = (sessionId: string) =>
    testDb.db.select().from(romeAgentMessages).where(eq(romeAgentMessages.sessionId, sessionId));

  beforeEach(() => {
    testDb = createTestDb();
    chats = new WebChatRepository(testDb.db);
    person = null;
    policy = { action: "sentinel_review" };
    loaded = new Set(["sales:agent"]);
    evaluatePolicy.mockClear();
  });

  afterEach(() => testDb.close());

  it("stores a notification row with the message's fields", async () => {
    const result = await record()({
      ref: REF,
      service: "feishu",
      message: message({ replyTo: { messageId: "om-0", content: "earlier" } }),
    });

    expect(result).toEqual({ status: "recorded" });
    const [chat] = await sessions();
    expect(chat).toMatchObject({
      type: "channel",
      sourceChannel: "feishu",
      sourceThreadId: "group-1",
      sourceThreadName: "Team",
      sourceThreadType: "group",
      agentName: null,
    });
    const [row] = await rows(chat!.id);
    expect(row).toMatchObject({
      role: "notification",
      turnId: null,
      content: JSON.stringify([{ type: "text", content: "lunch at noon?" }]),
      platformMessageId: "om-1",
      senderId: "ou-alice",
      senderName: "Alice",
      replyToPlatformMessageId: "om-0",
      createdAt: new Date("2026-10-20T12:00:00Z"),
    });
    expect(evaluatePolicy).toHaveBeenCalledWith({
      channel: "feishu",
      sender: null,
      bondLevel: "other",
      threadName: "Team",
      threadType: "group",
    });
  });

  it("names the sender by id when the channel gave no display name", async () => {
    await record()({
      ref: REF,
      service: "feishu",
      message: message({ senderDisplayName: undefined }),
    });

    const [chat] = await sessions();
    expect((await rows(chat!.id))[0]?.senderName).toBe("ou-alice");
  });

  it("reads a redelivered message as a duplicate", async () => {
    const recorder = record();
    await recorder({ ref: REF, service: "feishu", message: message() });

    await expect(recorder({ ref: REF, service: "feishu", message: message() })).resolves.toEqual({
      status: "duplicate",
    });
    const [chat] = await sessions();
    expect(await rows(chat!.id)).toHaveLength(1);
  });

  it("records nothing for a sender a policy blocks", async () => {
    person = { id: "person-bob", bondLevel: "acquaintance" };
    policy = { action: "block" };

    await expect(record()({ ref: REF, service: "feishu", message: message() })).resolves.toEqual({
      status: "blocked",
    });
    expect(evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: { id: "person-bob", bondLevel: "acquaintance" },
        bondLevel: "acquaintance",
      }),
    );
    expect(await sessions()).toEqual([]);
  });

  it("opens a native thread's parent chat and stores the row on the thread", async () => {
    await record()({
      ref: { ...REF, chatId: "thread-1" as ChatId },
      service: "feishu",
      message: message({
        chatId: "thread-1" as ChatId,
        parentChatId: "group-1" as ChatId,
        thread: { kind: "topic", name: "Lunch" },
      }),
      routedAgentName: "sales:agent",
    });

    const all = await sessions();
    const parent = all.find((chat) => chat.sourceThreadId === "group-1");
    const thread = all.find((chat) => chat.sourceThreadId === "thread-1");
    expect(parent).toMatchObject({ agentName: "sales:agent" });
    expect(thread).toMatchObject({ parentSessionId: parent!.id, agentName: "sales:agent" });
    expect(await rows(thread!.id)).toHaveLength(1);
    expect(await rows(parent!.id)).toHaveLength(0);
  });

  it.each([
    ["the chat's loaded agent", "sales:agent", "sales:agent"],
    ["main for an agent that is not loaded", "gone:agent", null],
    ["main for an explicit pin to main", "core:main", null],
    ["main with no choice", undefined, null],
  ])("stores %s on a new chat", async (_name, routedAgentName, stored) => {
    await record()({ ref: REF, service: "feishu", message: message(), routedAgentName });

    const [chat] = await sessions();
    expect(chat?.agentName).toBe(stored);
  });

  it("names saved attachments' paths in the stored text", async () => {
    await record()({
      ref: REF,
      service: "feishu",
      message: message({
        text: "see this",
        attachments: [
          { type: "image", url: "img-key", localPath: "/data/photo.jpg", fileName: "photo.jpg" },
          { type: "document", url: "not-saved" },
        ],
      }),
    });

    const [chat] = await sessions();
    expect((await rows(chat!.id))[0]?.content).toBe(
      JSON.stringify([
        {
          type: "text",
          content:
            "see this\n\nAttachment 1 (image photo.jpg) path: /data/photo.jpg\n\nAttachment (document) not downloaded",
        },
      ]),
    );
  });

  it("names a file-only message's attachments when none was downloaded", async () => {
    await record()({
      ref: REF,
      service: "discord",
      message: message({
        text: "",
        attachments: [{ type: "image", url: "https://cdn/x.png", fileName: "x.png" }],
      }),
    });

    const [chat] = await sessions();
    expect((await rows(chat!.id))[0]?.content).toBe(
      JSON.stringify([{ type: "text", content: "Attachment (image x.png) not downloaded" }]),
    );
  });
});

// `message_handler` stores the same rows on a host without the recorder, and
// an app cannot import @rome/core, so the two copies of the formatter are
// checked against each other here.
describe("appendAttachmentPathsToPrompt", () => {
  it.each([
    ["text only", " hi ", []],
    ["attachments only", "", [{ type: "image", localPath: "/a.png", caption: "cap" }]],
    [
      "text and several attachments",
      "look",
      [
        { type: "document", localPath: "/b.pdf", fileName: "b.pdf" },
        { type: "image", url: "unsaved" },
        { type: "audio", localPath: "  " },
        { type: "video", localPath: "/c.mp4" },
      ],
    ],
    ["attachments that are not a list", "x", "nope"],
  ])("reads like message_handler's for %s", (_name, text, attachments) => {
    expect(appendAttachmentPathsToPrompt(text, attachments)).toBe(
      inboxAppendAttachmentPaths(text, attachments),
    );
  });
});
