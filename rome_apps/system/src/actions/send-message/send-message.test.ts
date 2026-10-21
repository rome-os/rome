import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  setCurrentActionContextResolver,
  type ActionConfig,
  type ChannelsService,
  type ChatRepository,
} from "@rome-os/app-runtime";
import { createSendMessageAction, executeSendMessage } from "./index.js";
import type { AgentNamesService, SendMessageInput } from "./index.js";

let tempDir = "";
let projectsRoot = "";
let outsideRoot = "";

/** A channels service with one channel, `service`, backed by one Connection. */
function makeAdapter(service = "discord"): ChannelsService {
  return {
    list: rs.fn(async () => [{ name: service, sendable: true }]),
    send: rs.fn(async (_channel, chatId) => ({ chatId })),
    query: async () => [],
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

    expect(adapter.send).toHaveBeenCalledWith("discord", "thread-1", {
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
  function makeEmailAdapter(): ChannelsService {
    const adapter = makeAdapter("email");
    (adapter.send as ReturnType<typeof rs.fn>).mockResolvedValue({
      chatId: "t1",
      messageId: "msg_1",
    });
    return adapter;
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
    const [channel, threadId, message] = (adapter.send as ReturnType<typeof rs.fn>).mock.calls[0];
    expect(channel).toBe("email");
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

  it("rejects email attachments before checking their sources or the body", async () => {
    const adapter = makeEmailAdapter();
    await expect(
      executeSendMessage(adapter, {
        channel: "email",
        to: "x@y.com",
        attachments: [{ type: "document", source: "/outside/any/workspace.txt" }],
      }),
    ).rejects.toThrow("Email attachments are not supported by the mail transport");
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("rejects an email whose text and html are blank", async () => {
    const adapter = makeEmailAdapter();
    await expect(
      executeSendMessage(adapter, { channel: "email", to: "x@y.com", text: " ", html: "" }),
    ).rejects.toThrow("Email requires non-empty `text` or `html`");
    expect(adapter.send).not.toHaveBeenCalled();
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

    expect(adapter.send).toHaveBeenCalledWith("webchat", "session-1", {
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
    expect(adapter.send).toHaveBeenCalledWith("whatsapp", "15551234567@s.whatsapp.net", {
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

describe("send_message connection choice", () => {
  // A channel no Connection can send on is refused before anything else, so
  // the error names the channel rather than an attachment or a recipient.
  it("refuses an unconfigured channel before checking attachments or recipients", async () => {
    const adapter = makeAdapter("telegram_user");
    const personMappingRepo = {
      findByBondLevel: rs.fn(async () => [{ channelMappings: [] }]),
    };

    await expect(
      executeSendMessage(adapter, {
        channel: "discord",
        threadId: "thread-1",
        attachments: [{ type: "document", source: "/outside/secret.txt" }],
      }),
    ).rejects.toThrow('No Talk connection registered for "discord"');
    await expect(
      executeSendMessage(
        adapter,
        { channel: "whatsapp", to: "guardian", text: "hello guardian" },
        { personMappingRepo },
      ),
    ).rejects.toThrow('No Talk connection registered for "whatsapp"');
    expect(personMappingRepo.findByBondLevel).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });
});

describe("send_message to an account with an opaque id", () => {
  const FIRST = "6f1d2c3b-0000-4000-8000-000000000001";
  const SECOND = "6f1d2c3b-0000-4000-8000-000000000002";

  function accounts(...names: string[]): ChannelsService {
    return {
      list: rs.fn(async () => [
        { name: "telegram", platform: "telegram", sendable: false },
        ...names.map((name) => ({ name, platform: "telegram", sendable: true })),
      ]),
      send: rs.fn(async (_channel, chatId) => ({ chatId })),
      query: async () => [],
    };
  }

  it("sends as the account its id names", async () => {
    const adapter = accounts(FIRST, SECOND);

    await executeSendMessage(adapter, { channel: SECOND, threadId: "42", text: "hi" });

    expect(adapter.send).toHaveBeenCalledWith(
      SECOND,
      "42",
      expect.objectContaining({ text: "hi" }),
    );
  });

  it("refuses a platform name that is not an account's id", async () => {
    const adapter = accounts(FIRST);

    await expect(
      executeSendMessage(adapter, { channel: "telegram", threadId: "42", text: "hi" }),
    ).rejects.toThrow('No Talk connection registered for "telegram"');
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("resolves to: guardian through the link People keys by platform", async () => {
    const adapter = accounts(FIRST);
    const personMappingRepo = {
      findByBondLevel: rs.fn(async () => [
        { channelMappings: [{ channel: "telegram", channelUserId: "1001" }] },
      ]),
    };

    await executeSendMessage(
      adapter,
      { channel: FIRST, to: "guardian", text: "hi" },
      { personMappingRepo },
    );

    expect(adapter.send).toHaveBeenCalledWith(
      FIRST,
      "1001",
      expect.objectContaining({ text: "hi" }),
    );
  });

  // People files a signed-in Telegram's links under its own key, not under
  // the platform, until links are keyed by platform.
  it("resolves to: guardian under the key People files the account's links by", async () => {
    const adapter = accounts(FIRST);
    const personMappingRepo = {
      findByBondLevel: rs.fn(async () => [
        {
          channelMappings: [
            { channel: "telegram", channelUserId: "1001" },
            { channel: "telegram_user", channelUserId: "2002" },
          ],
        },
      ]),
      linkKeyOf: rs.fn(async () => "telegram_user"),
    };

    await executeSendMessage(
      adapter,
      { channel: FIRST, to: "guardian", text: "hi" },
      { personMappingRepo },
    );

    expect(personMappingRepo.linkKeyOf).toHaveBeenCalledWith(FIRST);
    expect(adapter.send).toHaveBeenCalledWith(
      FIRST,
      "2002",
      expect.objectContaining({ text: "hi" }),
    );
  });
});

describe("send_message conversation recording", () => {
  it("stores a confirmed out-of-band delivery as a pending notification", async () => {
    const adapter = makeAdapter();
    (adapter.send as ReturnType<typeof rs.fn>).mockResolvedValue({
      messageId: "platform-out-1",
      chatId: "thread-1",
    });
    const ensureChannelChat = rs.fn(async () => ({
      id: "channel:discord:thread-1",
      agentName: null,
    }));
    const recordOutboundMessage = rs.fn(async () => undefined);

    const result = await executeSendMessage(
      adapter,
      { channel: "discord", threadId: "thread-1", text: "Background update" },
      {
        chats: {
          ensureChannelChat,
          recordOutboundMessage,
          addMessage: rs.fn(),
          promoteMessageToUser: rs.fn(),
        },
      },
    );

    expect(result).toEqual({ status: "ok", data: { messageId: "platform-out-1" } });
    expect(ensureChannelChat).toHaveBeenCalledWith(
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

  it("records a delivery through a host that predates the chat names", async () => {
    const adapter = makeAdapter();
    (adapter.send as ReturnType<typeof rs.fn>).mockResolvedValue({
      messageId: "platform-out-1",
      chatId: "thread-1",
    });
    const recordOutboundMessage = rs.fn(async () => undefined);
    // Only the old method, reading its own receiver as a host repository can.
    const legacy = {
      sessionId: "channel:discord:thread-1",
      async ensureChannelConversation() {
        return { id: this.sessionId, agentName: null };
      },
      recordOutboundMessage,
      addMessage: rs.fn(),
      promoteMessageToUser: rs.fn(),
    };

    await executeSendMessage(
      adapter,
      { channel: "discord", threadId: "thread-1", text: "Background update" },
      { chats: legacy as unknown as ChatRepository },
    );

    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "channel:discord:thread-1" }),
    );
  });

  it("leaves a webchat send to the channel, which writes it into the chat", async () => {
    const adapter = makeAdapter("webchat");
    (adapter.send as ReturnType<typeof rs.fn>).mockResolvedValue({
      messageId: "webchat-out-1",
      chatId: "session-1",
    });
    const ensureChannelChat = rs.fn();
    const recordOutboundMessage = rs.fn();

    const result = await executeSendMessage(
      adapter,
      { channel: "webchat", threadId: "session-1", text: "Background update" },
      {
        chats: {
          ensureChannelChat,
          recordOutboundMessage,
          addMessage: rs.fn(),
          promoteMessageToUser: rs.fn(),
        },
      },
    );

    expect(result).toEqual({ status: "ok", data: { messageId: "webchat-out-1" } });
    expect(ensureChannelChat).not.toHaveBeenCalled();
    expect(recordOutboundMessage).not.toHaveBeenCalled();
  });

  it("keeps a confirmed delivery successful when transcript recording fails", async () => {
    const adapter = makeAdapter();
    (adapter.send as ReturnType<typeof rs.fn>).mockResolvedValue({
      messageId: "platform-out-2",
      chatId: "thread-2",
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
          chats: {
            ensureChannelChat: rs.fn(),
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

  it("names the agent a message goes to by name, but never shows an agent id", () => {
    const action = createSendMessageAction(config, makeAdapter("agents"));
    const id = "0b6f6f8e-8a4c-4f3e-9c9d-2f1a3b4c5d6e";

    expect(action.preview!({ channel: "agents", to: "Atlas", text: "hi" })).toMatchObject({
      fields: [
        { label: "Channel", value: "Agents" },
        { label: "To", value: "Atlas" },
      ],
    });
    expect(action.preview!({ channel: "agents", to: id, text: "hi" })).toMatchObject({
      fields: [{ label: "Channel", value: "Agents" }],
    });
    expect(
      JSON.stringify(action.preview!({ channel: "agents", to: id, text: "hi" })),
    ).not.toContain(id);
  });
});

describe("send_message to an agent by name", () => {
  const ATLAS = "0b6f6f8e-8a4c-4f3e-9c9d-2f1a3b4c5d6e";
  const FRIEND_ATLAS = "1c7a7f9e-9b5d-4a4f-8d0e-3a2b4c5d6e7f";

  function names(answer: Awaited<ReturnType<AgentNamesService["resolve"]>>) {
    return { resolve: rs.fn<AgentNamesService["resolve"]>(async () => answer) };
  }

  beforeEach(() =>
    setCurrentActionContextResolver(() => ({ executionId: "e", agentName: "main" })),
  );
  afterEach(() => setCurrentActionContextResolver(null));

  it("sends to the agent the name resolves to", async () => {
    const adapter = makeAdapter("agents");
    const agentNames = names({ status: "found", agentId: ATLAS });

    await executeSendMessage(
      adapter,
      { channel: "agents", to: "Atlas", text: "hi" },
      { agentNames },
    );

    expect(agentNames.resolve).toHaveBeenCalledWith("Atlas");
    expect(adapter.send).toHaveBeenCalledWith(
      "agents",
      ATLAS,
      expect.objectContaining({ text: "hi" }),
    );
  });

  it("refuses a name two agents share, naming each with its id", async () => {
    const adapter = makeAdapter("agents");
    const agentNames = names({
      status: "ambiguous",
      matches: [
        { label: "Atlas (dot)", agentId: ATLAS },
        { label: "Atlas (@friend's dot)", agentId: FRIEND_ATLAS },
      ],
    });

    const sent = executeSendMessage(
      adapter,
      { channel: "agents", to: "Atlas", text: "hi" },
      { agentNames },
    );

    await expect(sent).rejects.toThrow(`"Atlas (dot)" (threadId ${ATLAS})`);
    await expect(sent).rejects.toThrow(`"Atlas (@friend's dot)" (threadId ${FRIEND_ATLAS})`);
    await expect(sent).rejects.toThrow("full name as `to`");
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("offers only the id when the agents share a whole label", async () => {
    const adapter = makeAdapter("agents");
    const agentNames = names({
      status: "ambiguous",
      matches: [
        { label: "Atlas (dot)", agentId: ATLAS },
        { label: "Atlas (dot)", agentId: FRIEND_ATLAS },
      ],
    });

    const sent = executeSendMessage(
      adapter,
      { channel: "agents", to: "Atlas", text: "hi" },
      { agentNames },
    );

    await expect(sent).rejects.toThrow("Send again with the id as `threadId`.");
    await expect(sent).rejects.not.toThrow("full name");
  });

  it("says when no agent has the name, or Agents is not connected", async () => {
    const adapter = makeAdapter("agents");
    const input = { channel: "agents" as const, to: "Atlas", text: "hi" };

    await expect(
      executeSendMessage(adapter, input, { agentNames: names({ status: "none" }) }),
    ).rejects.toThrow('No agent named "Atlas"');
    await expect(
      executeSendMessage(adapter, input, { agentNames: names({ status: "not_connected" }) }),
    ).rejects.toThrow('Channel "agents" is not connected');
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("sends to an id given as `to` in any case without looking it up", async () => {
    const adapter = makeAdapter("agents");
    const agentNames = names({ status: "none" });

    await executeSendMessage(
      adapter,
      { channel: "agents", to: ATLAS.toUpperCase(), text: "hi" },
      { agentNames },
    );

    expect(agentNames.resolve).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith("agents", ATLAS, expect.anything());
  });

  it("reads a padded guardian alias as the alias, as the approval card does", async () => {
    const adapter = makeAdapter("agents");
    const agentNames = names({ status: "found", agentId: ATLAS });
    const personMappingRepo = {
      findByBondLevel: rs.fn(async () => [
        { channelMappings: [{ channel: "agents", channelUserId: ATLAS }] },
      ]),
    };

    await executeSendMessage(
      adapter,
      { channel: "agents", to: " guardian", text: "hi" },
      { agentNames, personMappingRepo },
    );

    expect(agentNames.resolve).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith("agents", ATLAS, expect.anything());
  });

  it("says what `to` takes on agents when it is empty", async () => {
    const adapter = makeAdapter("agents");

    await expect(
      executeSendMessage(adapter, { channel: "agents", to: " ", text: "hi" }),
    ).rejects.toThrow('Channel "agents" takes an agent\'s name or "guardian" as `to`');
  });

  it("refuses a name from any agent but main, without looking", async () => {
    setCurrentActionContextResolver(() => ({ executionId: "e", agentName: "assistant:assistant" }));
    const adapter = makeAdapter("agents");
    const agentNames = names({ status: "found", agentId: ATLAS });

    await expect(
      executeSendMessage(adapter, { channel: "agents", to: "Atlas", text: "hi" }, { agentNames }),
    ).rejects.toThrow("Only Rome's main agent sends to an agent by name");
    expect(agentNames.resolve).not.toHaveBeenCalled();
  });

  it("refuses a name from an installed app calling through runAction", async () => {
    setCurrentActionContextResolver(() => ({
      executionId: "e",
      agentName: "main",
      callerAppId: "some-app",
    }));
    const adapter = makeAdapter("agents");
    const agentNames = names({ status: "found", agentId: ATLAS });

    await expect(
      executeSendMessage(adapter, { channel: "agents", to: "Atlas", text: "hi" }, { agentNames }),
    ).rejects.toThrow("Only Rome's main agent sends to an agent by name");
    expect(agentNames.resolve).not.toHaveBeenCalled();
  });

  it("says names need the lookup when this Rome has none", async () => {
    const adapter = makeAdapter("agents");

    await expect(
      executeSendMessage(adapter, { channel: "agents", to: "Atlas", text: "hi" }),
    ).rejects.toThrow("Sending to an agent by name is not available");
  });
});
