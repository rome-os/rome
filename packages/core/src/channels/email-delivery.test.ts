import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ChannelsService,
  ConversationId,
  ConversationRepository,
  MessageReceipt,
} from "@rome-os/app-runtime";
import { executeSendMessage } from "../../../../rome_apps/system/src/actions/send-message/index.js";
import type { SendMessageEmailInput } from "../../../../rome_apps/system/src/actions/send-message/types.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { MailProvider, RomeMailListItem, SendMailResult } from "../lib/rome-cloud-mail.js";
import { EmailAdapter } from "./email.js";

const THREAD = "provider-thread";
const GUARDIAN = "guardian@example.com";

function listItem(providerMessageId: string): RomeMailListItem {
  return {
    providerMessageId,
    threadId: THREAD,
    receivedAt: "2020-01-01T00:00:00.000Z",
    labels: ["sent"],
  };
}

async function harness(overrides: Partial<MailProvider> = {}) {
  let sequence = 0;
  const provider: MailProvider = {
    provision: rs.fn(async () => ({ address: "rome@example.com", inboundSecret: "secret" })),
    send: rs.fn(async () => ({ messageId: `sent-${++sequence}`, threadId: THREAD })),
    listMessages: rs.fn(async () => ({ messages: [] })),
    getMessage: rs.fn(async () => {
      throw new Error("unexpected body fetch");
    }),
    getAttachment: rs.fn(async () => {
      throw new Error("unexpected attachment fetch");
    }),
    ...overrides,
  };
  const adapter = new EmailAdapter({
    provider,
    settingsRepo: {
      get: async () => ({ enabled: true, guardianEmail: GUARDIAN }),
    } as unknown as SettingsRepository,
    personMappingRepo: {
      findByChannelUser: async () => null,
      findByBondLevel: async () => [],
    } as unknown as PersonMappingRepository,
    config: { address: "rome@example.com", inboundSecret: "secret" },
  });
  await adapter.start();
  const send: ChannelsService["send"] = (_channel, conversationId, message) =>
    adapter.send(conversationId, message);
  const channels: ChannelsService = {
    list: async () => [{ name: "email", sendable: true }],
    send: rs.fn(send),
    query: async () => [],
  };
  const ensureChannelConversation = rs.fn(async () => ({ id: "session", agentName: null }));
  const recordOutboundMessage = rs.fn(
    async (_input: Parameters<ConversationRepository["recordOutboundMessage"]>[0]) => undefined,
  );
  const deps = {
    conversations: {
      ensureChannelConversation,
      recordOutboundMessage,
    } as unknown as ConversationRepository,
  };
  return { provider, adapter, channels, deps, ensureChannelConversation, recordOutboundMessage };
}

describe("email delivery through send_message", () => {
  let workspace: string;
  let source: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "rome-email-delivery-"));
    source = join(workspace, "report.txt");
    await writeFile(source, "report content");
    rs.stubEnv("ROME_PROJECTS_ROOT", workspace);
  });

  afterEach(async () => {
    rs.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns and records provider IDs for a new send and consecutive thread-only replies", async () => {
    const h = await harness();
    const inputs: SendMessageEmailInput[] = [
      { channel: "email", to: "guardian", subject: "Report", text: "first" },
      { channel: "email", threadId: THREAD, text: "second" },
      { channel: "email", threadId: THREAD, text: "third" },
    ];
    for (const [index, input] of inputs.entries()) {
      await expect(executeSendMessage(h.channels, input, h.deps)).resolves.toEqual({
        status: "ok",
        data: { messageId: `sent-${index + 1}`, threadId: THREAD },
      });
    }
    expect(h.provider.send).toHaveBeenNthCalledWith(1, expect.objectContaining({ to: GUARDIAN }));
    expect(h.provider.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inReplyToMessageId: "sent-1", text: "second" }),
    );
    expect(h.provider.send).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ inReplyToMessageId: "sent-2", text: "third" }),
    );
    expect(h.provider.listMessages).not.toHaveBeenCalled();
    expect(h.recordOutboundMessage.mock.calls.map(([row]) => row.platformMessageId)).toEqual([
      "sent-1",
      "sent-2",
      "sent-3",
    ]);
  });

  it("resolves an outbound-only thread after restart without fetching history", async () => {
    const original = await harness();
    await executeSendMessage(original.channels, {
      channel: "email",
      to: "guardian",
      text: "first",
    });
    await original.adapter.stop();
    const h = await harness({
      listMessages: rs.fn(async () => ({ messages: [listItem("persisted-send")] })),
    });

    await expect(
      executeSendMessage(
        h.channels,
        { channel: "email", threadId: THREAD, text: "after restart" },
        h.deps,
      ),
    ).resolves.toEqual({
      status: "ok",
      data: { messageId: "sent-1", threadId: THREAD },
    });
    expect(h.provider.listMessages).toHaveBeenCalledTimes(1);
    expect(h.provider.listMessages).toHaveBeenCalledWith({
      ascending: false,
      limit: 100,
      pageToken: undefined,
    });
    expect(h.provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyToMessageId: "persisted-send", text: "after restart" }),
    );
    expect(h.provider.getMessage).not.toHaveBeenCalled();
    expect(h.recordOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit reply message before cached state or mailbox lookup", async () => {
    const h = await harness();
    await executeSendMessage(h.channels, { channel: "email", to: "guardian", text: "first" });
    await executeSendMessage(h.channels, {
      channel: "email",
      threadId: THREAD,
      replyToMessageId: "explicit",
      text: "reply",
    });

    expect(h.provider.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ inReplyToMessageId: "explicit" }),
    );
    expect(h.provider.listMessages).not.toHaveBeenCalled();
  });

  it("never converts an unresolved explicit thread to a fresh email, even with to", async () => {
    for (const threadId of ["missing-thread", "opaque@thread-id"]) {
      const h = await harness();
      await expect(
        executeSendMessage(
          h.channels,
          { channel: "email", threadId, to: "guardian", text: "reply" },
          h.deps,
        ),
      ).rejects.toThrow("Cannot resolve email thread");
      expect(h.provider.send).not.toHaveBeenCalled();
      expect(h.ensureChannelConversation).not.toHaveBeenCalled();
      expect(h.recordOutboundMessage).not.toHaveBeenCalled();
    }
  });

  it("rejects attachment-only and body-plus-attachment sends before any provider I/O", async () => {
    for (const text of [undefined, "See attached"]) {
      const h = await harness();
      await expect(
        executeSendMessage(
          h.channels,
          {
            channel: "email",
            threadId: THREAD,
            text,
            attachments: [{ type: "document", source }],
          },
          h.deps,
        ),
      ).rejects.toThrow("Email attachments are not supported");
      expect(h.provider.send).not.toHaveBeenCalled();
      expect(h.provider.listMessages).not.toHaveBeenCalled();
      expect(h.ensureChannelConversation).not.toHaveBeenCalled();
      expect(h.recordOutboundMessage).not.toHaveBeenCalled();
    }
  });

  it("rejects attachments on fresh emails rather than sending only their bodies", async () => {
    const h = await harness();
    await expect(
      executeSendMessage(
        h.channels,
        {
          channel: "email",
          to: "guardian",
          subject: "Report",
          text: "See attached",
          attachments: [{ type: "document", source }],
        },
        h.deps,
      ),
    ).rejects.toThrow("No email was sent");
    expect(h.provider.send).not.toHaveBeenCalled();
    expect(h.recordOutboundMessage).not.toHaveBeenCalled();
  });

  it("rejects empty bodies before delivery and accepts text parts when text is absent", async () => {
    const h = await harness();
    await expect(
      executeSendMessage(
        h.channels,
        { channel: "email", to: "guardian", text: "   ", html: " \n " },
        h.deps,
      ),
    ).rejects.toThrow("non-empty");
    expect(h.channels.send).not.toHaveBeenCalled();
    expect(h.recordOutboundMessage).not.toHaveBeenCalled();

    await executeSendMessage(
      h.channels,
      { channel: "email", to: "guardian", parts: [{ type: "text", content: "from parts" }] },
      h.deps,
    );
    expect(h.provider.send).toHaveBeenCalledWith(expect.objectContaining({ text: "from parts" }));
  });

  it("rejects unresolved recipients and blank explicit reply IDs without sending", async () => {
    for (const input of [
      { channel: "email" as const, to: "not-an-address", text: "hello" },
      { channel: "email" as const, to: "guardian", replyToMessageId: " ", text: "hello" },
    ]) {
      const h = await harness();
      await expect(executeSendMessage(h.channels, input, h.deps)).rejects.toThrow(
        "No email was sent",
      );
      expect(h.provider.send).not.toHaveBeenCalled();
      expect(h.provider.listMessages).not.toHaveBeenCalled();
      expect(h.recordOutboundMessage).not.toHaveBeenCalled();
    }
  });

  it("does not record a failed lookup or provider send, and does not retry either", async () => {
    const lookupError = new Error("lookup unavailable");
    const h = await harness({
      listMessages: rs.fn<MailProvider["listMessages"]>().mockRejectedValue(lookupError),
    });
    await expect(
      executeSendMessage(h.channels, { channel: "email", threadId: THREAD, text: "reply" }, h.deps),
    ).rejects.toBe(lookupError);
    expect(h.provider.listMessages).toHaveBeenCalledTimes(1);
    expect(h.provider.send).not.toHaveBeenCalled();
    expect(h.recordOutboundMessage).not.toHaveBeenCalled();

    const sendError = new Error("send unavailable");
    const failed = await harness({
      send: rs.fn<MailProvider["send"]>().mockRejectedValue(sendError),
    });
    await expect(
      executeSendMessage(
        failed.channels,
        { channel: "email", to: "guardian", text: "hello" },
        failed.deps,
      ),
    ).rejects.toBe(sendError);
    expect(failed.provider.send).toHaveBeenCalledTimes(1);
    expect(failed.ensureChannelConversation).not.toHaveBeenCalled();
    expect(failed.recordOutboundMessage).not.toHaveBeenCalled();
    await expect(failed.adapter.send(THREAD as ConversationId, { text: "reply" })).rejects.toThrow(
      "Cannot resolve email thread",
    );
    expect(failed.provider.send).toHaveBeenCalledTimes(1);
  });

  it("rejects unconfirmed channel receipts before writing any local transcript", async () => {
    for (const receipt of [
      undefined,
      {},
      { conversationId: THREAD },
      { conversationId: THREAD, messageId: " " },
      { messageId: "sent" },
      { messageId: "sent", conversationId: " " },
    ]) {
      const h = await harness();
      h.channels.send = rs.fn(async () => receipt as MessageReceipt);
      await expect(
        executeSendMessage(h.channels, { channel: "email", to: "guardian", text: "hello" }, h.deps),
      ).rejects.toThrow("Check email history before retrying");
      expect(h.channels.send).toHaveBeenCalledTimes(1);
      expect(h.ensureChannelConversation).not.toHaveBeenCalled();
      expect(h.recordOutboundMessage).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed provider receipts without claiming that no email was sent", async () => {
    for (const receipt of [
      undefined,
      { messageId: "", threadId: THREAD },
      { messageId: "sent", threadId: "" },
      { messageId: 123, threadId: THREAD },
    ]) {
      const h = await harness({ send: rs.fn(async () => receipt as SendMailResult) });
      await expect(
        executeSendMessage(h.channels, { channel: "email", to: "guardian", text: "hello" }, h.deps),
      ).rejects.toThrow("Email delivery is unconfirmed");
      expect(h.provider.send).toHaveBeenCalledTimes(1);
      expect(h.recordOutboundMessage).not.toHaveBeenCalled();
      await expect(h.adapter.send(THREAD as ConversationId, { text: "reply" })).rejects.toThrow(
        "Cannot resolve email thread",
      );
      expect(h.provider.send).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps provider acceptance successful when the transcript write fails", async () => {
    const h = await harness();
    h.recordOutboundMessage.mockRejectedValue(new Error("database unavailable"));
    await expect(
      executeSendMessage(h.channels, { channel: "email", to: "guardian", text: "hello" }, h.deps),
    ).resolves.toEqual({
      status: "ok",
      data: { messageId: "sent-1", threadId: THREAD },
    });
    expect(h.provider.send).toHaveBeenCalledTimes(1);
    expect(h.recordOutboundMessage).toHaveBeenCalledTimes(1);
  });
});
