import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig, TalkRouter } from "@rome-os/app-runtime";
import { createSendMessageAction, executeSendMessage } from "./index.js";
import type { SendMessageInput } from "./index.js";

let tempDir = "";
let projectsRoot = "";
let outsideRoot = "";

function makeAdapter(service = "discord"): TalkRouter {
  return {
    list: async () => [{ connectionId: `test:${service}`, service }],
    subscribe: () => () => {},
    send: rs.fn(async (_connectionId, conversationId) => ({ conversationId })),
    feature: () => null,
  };
}

describe("send_message attachments", () => {
  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "rome-send-message-"));
    projectsRoot = join(tempDir, "projects");
    outsideRoot = join(tempDir, "outside");
    await mkdir(projectsRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    rs.stubEnv("ROME_PROJECTS_ROOT", projectsRoot);
    rs.stubEnv("ROME_PROFILE", "send-message-test");
  });

  afterEach(() => {
    rs.unstubAllEnvs();
    rs.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sends attachments from the Rome projects workspace", async () => {
    const source = join(projectsRoot, "default", "report.pdf");
    await mkdir(join(projectsRoot, "default"), { recursive: true });
    await writeFile(source, "pdf");
    const safeSource = await realpath(source);
    const adapter = makeAdapter();

    await executeSendMessage(adapter, {
      channel: "discord",
      threadId: "thread-1",
      attachments: [{ type: "document", source, caption: "Report" }],
    });

    expect(adapter.send).toHaveBeenCalledWith("test:discord", "thread-1", {
      text: undefined,
      attachments: [{ type: "document", source: safeSource, caption: "Report" }],
      replyToMessageId: undefined,
      turnId: undefined,
    });
  });

  it("rejects absolute paths outside allowed attachment roots", async () => {
    const source = join(outsideRoot, "secret.txt");
    await writeFile(source, "secret");
    const adapter = makeAdapter();

    await expect(
      executeSendMessage(adapter, {
        channel: "discord",
        threadId: "thread-1",
        attachments: [{ type: "document", source }],
      }),
    ).rejects.toThrow("Attachment source must be under");

    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("rejects symlinks that escape the allowed workspace", async () => {
    const target = join(outsideRoot, "secret.txt");
    const link = join(projectsRoot, "default", "linked-secret.txt");
    await mkdir(join(projectsRoot, "default"), { recursive: true });
    await writeFile(target, "secret");
    await symlink(target, link);
    const adapter = makeAdapter();

    await expect(
      executeSendMessage(adapter, {
        channel: "discord",
        threadId: "thread-1",
        attachments: [{ type: "document", source: link }],
      }),
    ).rejects.toThrow("Attachment source must be under");

    expect(adapter.send).not.toHaveBeenCalled();
  });
});

describe("send_message email union", () => {
  function makeEmailAdapter(): TalkRouter {
    return makeAdapter("email");
  }

  it("maps email-specific fields into OutgoingMessage.email for a new email", async () => {
    const adapter = makeEmailAdapter();
    await executeSendMessage(adapter, {
      channel: "email",
      to: "guardian",
      subject: "Hi",
      cc: ["c@x.com"],
      text: "body",
    });

    expect(adapter.send).toHaveBeenCalledTimes(1);
    const [connectionId, threadId, message] = (adapter.send as ReturnType<typeof rs.fn>).mock
      .calls[0];
    expect(connectionId).toBe("test:email");
    expect(threadId).toBe("");
    expect(message.kind).toBe("email");
    expect(message.text).toBe("body");
    expect(message).toMatchObject({ to: "guardian", subject: "Hi", cc: ["c@x.com"] });
  });

  it("maps replyToMessageId to email.inReplyToMessageId for an on-thread reply", async () => {
    const adapter = makeEmailAdapter();
    await executeSendMessage(adapter, {
      channel: "email",
      threadId: "t1",
      replyToMessageId: "msg_1",
      text: "reply",
    });

    const [, , message] = (adapter.send as ReturnType<typeof rs.fn>).mock.calls[0];
    expect(message.kind).toBe("email");
    expect(message.inReplyToMessageId).toBe("msg_1");
  });

  it("rejects an email with neither a thread nor a recipient", async () => {
    const adapter = makeEmailAdapter();
    await expect(executeSendMessage(adapter, { channel: "email", text: "x" })).rejects.toThrow(
      /to reply, or a .to. recipient/,
    );
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("allows an html-only email body", async () => {
    const adapter = makeEmailAdapter();
    await executeSendMessage(adapter, {
      channel: "email",
      to: "x@y.com",
      html: "<p>hi</p>",
    });
    const [, , message] = (adapter.send as ReturnType<typeof rs.fn>).mock.calls[0];
    expect(message.html).toBe("<p>hi</p>");
  });
});

describe("send_message chat recipient aliases", () => {
  it("forwards WebChat text-block identity unchanged", async () => {
    const adapter = makeAdapter("webchat");
    const parts = [
      {
        type: "text" as const,
        content: "Final answer",
        turnPhase: "final" as const,
        blockIx: 2,
      },
    ];

    await executeSendMessage(adapter, {
      channel: "webchat",
      threadId: "session-1",
      text: "Final answer",
      parts,
      turnId: "turn-1",
    });

    expect(adapter.send).toHaveBeenCalledWith("test:webchat", "session-1", {
      text: "Final answer",
      parts,
      attachments: undefined,
      replyToMessageId: undefined,
      turnId: "turn-1",
    });
  });

  it("resolves WhatsApp to: guardian through the guardian channel mapping", async () => {
    const adapter = makeAdapter("whatsapp");
    const personMappingRepo = {
      findByBondLevel: rs.fn(async () => [
        {
          channelMappings: [
            { channel: "email", channelUserId: "guardian@example.com" },
            { channel: "whatsapp", channelUserId: "15551234567@s.whatsapp.net" },
          ],
        },
      ]),
    };

    await executeSendMessage(
      adapter,
      {
        channel: "whatsapp",
        to: "guardian",
        text: "hello guardian",
      },
      { personMappingRepo },
    );

    expect(personMappingRepo.findByBondLevel).toHaveBeenCalledWith("guardian");
    expect(adapter.send).toHaveBeenCalledWith("test:whatsapp", "15551234567@s.whatsapp.net", {
      text: "hello guardian",
      parts: undefined,
      attachments: undefined,
      replyToMessageId: undefined,
      turnId: undefined,
    });
  });

  it("fails loudly when a chat guardian alias has no mapping for the channel", async () => {
    const adapter = makeAdapter("whatsapp");
    const personMappingRepo = {
      findByBondLevel: rs.fn(async () => [{ channelMappings: [] }]),
    };

    await expect(
      executeSendMessage(
        adapter,
        {
          channel: "whatsapp",
          to: "guardian",
          text: "hello guardian",
        },
        { personMappingRepo },
      ),
    ).rejects.toThrow('No guardian mapping found for channel "whatsapp"');
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("rejects unsupported chat recipient aliases", async () => {
    const adapter = makeAdapter("whatsapp");

    await expect(
      executeSendMessage(adapter, {
        channel: "whatsapp",
        to: "someone-else",
        text: "hello",
      } as unknown as SendMessageInput),
    ).rejects.toThrow('Channel "whatsapp" only supports to: "guardian"');
    expect(adapter.send).not.toHaveBeenCalled();
  });
});

describe("send_message conversation recording", () => {
  it("stores a confirmed out-of-band delivery as a pending notification", async () => {
    const adapter = makeAdapter();
    (adapter.send as ReturnType<typeof rs.fn>).mockResolvedValue({
      messageId: "platform-out-1",
      conversationId: "thread-1",
    });
    const ensureChannelConversation = rs.fn(async () => ({
      id: "channel:discord:thread-1",
      agentName: null,
    }));
    const recordOutboundMessage = rs.fn(async () => undefined);

    const result = await executeSendMessage(
      adapter,
      { channel: "discord", threadId: "thread-1", text: "Background update" },
      {
        conversations: {
          ensureChannelConversation,
          recordOutboundMessage,
          addMessage: rs.fn(),
          promoteMessageToUser: rs.fn(),
        },
      },
    );

    expect(result).toEqual({ status: "ok", data: { messageId: "platform-out-1" } });
    expect(ensureChannelConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        threadId: "thread-1",
      }),
    );
    expect(recordOutboundMessage).toHaveBeenCalledWith({
      sessionId: "channel:discord:thread-1",
      content: JSON.stringify([{ type: "text", content: "Background update" }]),
      platformMessageId: "platform-out-1",
      senderId: "rome",
      senderName: "Rome",
      replyToPlatformMessageId: undefined,
      turnId: undefined,
      knownToProvider: false,
    });
  });

  it("keeps a confirmed delivery successful when transcript recording fails", async () => {
    const adapter = makeAdapter();
    (adapter.send as ReturnType<typeof rs.fn>).mockResolvedValue({
      messageId: "platform-out-2",
      conversationId: "thread-2",
    });

    await expect(
      executeSendMessage(
        adapter,
        {
          channel: "discord",
          threadId: "thread-2",
          text: "Already delivered",
          romeSessionId: "channel:discord:thread-2",
          knownToProvider: true,
          turnId: "turn-2",
        },
        {
          conversations: {
            ensureChannelConversation: rs.fn(),
            recordOutboundMessage: rs.fn(async () => {
              throw new Error("database unavailable");
            }),
            addMessage: rs.fn(),
            promoteMessageToUser: rs.fn(),
          },
        },
      ),
    ).resolves.toEqual({ status: "ok", data: { messageId: "platform-out-2" } });
  });
});

describe("send_message preview", () => {
  const config = {
    name: "send_message",
    type: "system",
    description: "Send a message",
  } as ActionConfig;

  it("renders the message text and a human channel label, omitting raw recipient ids", () => {
    const action = createSendMessageAction(config, makeAdapter());
    const payload = action.preview!({
      channel: "telegram",
      threadId: "918273645",
      channelUserId: "918273645",
      text: "Good morning!",
    });

    expect(payload).toEqual({
      kind: "generic",
      title: "Send a message",
      summary: "Good morning!",
      fields: [{ label: "Channel", value: "Telegram" }],
    });
    // The raw thread/user id must never reach the card.
    expect(JSON.stringify(payload)).not.toContain("918273645");
  });

  it("falls back to the raw channel name for an unmapped adapter", () => {
    const action = createSendMessageAction(config, makeAdapter());
    const payload = action.preview!({ channel: "matrix", threadId: "t1", text: "hi" });

    expect(payload).toMatchObject({ fields: [{ label: "Channel", value: "matrix" }] });
  });
});
