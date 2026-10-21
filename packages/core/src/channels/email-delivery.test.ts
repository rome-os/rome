import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelsService, ChatId, ChatRepository, MessageReceipt } from "@rome-os/app-runtime";
import { executeSendMessage } from "../../../../rome_apps/system/src/actions/send-message/index.js";
import type { SendMessageEmailInput } from "../../../../rome_apps/system/src/actions/send-message/types.js";
import { DEFAULT_RPC_TIMEOUT_MS, IpcRpcTimeoutError } from "../actions/ipc.js";
import { ChannelsServiceProxy } from "../actions/service-proxies.js";
import { setWorkerRpcInProcessDispatcher } from "../actions/worker-rpc-client.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import {
  MAIL_REQUEST_TIMEOUT_MS,
  type MailProvider,
  type RomeMailEvent,
  type RomeMailListItem,
} from "../lib/rome-cloud-mail.js";
import { EmailAdapter } from "./email.js";
import { REPLY_LOOKUP_BUDGET_MS } from "./email-reply-target.js";

const THREAD = "provider-thread";
const GUARDIAN = "guardian@example.com";

function listItem(
  providerMessageId: string,
  labels: string[] = ["sent"],
  threadId = THREAD,
): RomeMailListItem {
  return {
    providerMessageId,
    threadId,
    receivedAt: "2020-01-01T00:00:00.000Z",
    labels,
  };
}

function inboundEvent(providerMessageId: string): string {
  const event: RomeMailEvent = {
    type: "message.received",
    provider: "agentmail",
    mailboxAddress: "rome@example.com",
    id: `evt-${providerMessageId}`,
    providerMessageId,
    threadId: THREAD,
    from: [{ name: "Alice", email: "alice@example.com" }],
    to: [{ email: "rome@example.com" }],
    subject: "Question",
    preview: "a question",
    receivedAt: "2020-01-01T00:00:00.000Z",
    hasAttachment: false,
    attachments: [],
    authentication: { authenticated: true, spam: false, blocked: false },
    labels: ["received"],
  };
  return JSON.stringify(event);
}

function sign(rawBody: string): string {
  return createHmac("sha256", "secret").update(rawBody).digest("hex");
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
  adapter.onInbound(async () => undefined);
  const send: ChannelsService["send"] = (_channel, conversationId, message) =>
    adapter.send(conversationId, message);
  const channels: ChannelsService = {
    list: async () => [{ name: "email", sendable: true }],
    send: rs.fn(send),
    query: async () => [],
  };
  const ensureChannelChat = rs.fn(async () => ({ id: "session", agentName: null }));
  const recordOutboundMessage = rs.fn(
    async (_input: Parameters<ChatRepository["recordOutboundMessage"]>[0]) => undefined,
  );
  const deps = {
    chats: {
      ensureChannelChat,
      recordOutboundMessage,
    } as unknown as ChatRepository,
  };
  return { provider, adapter, channels, deps, ensureChannelChat, recordOutboundMessage };
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

  it("sends a fresh email to an address and returns the provider receipt", async () => {
    const h = await harness();

    await expect(
      executeSendMessage(
        h.channels,
        { channel: "email", to: "alice@example.com", subject: "Hello", text: "hi" },
        h.deps,
      ),
    ).resolves.toEqual({ status: "ok", data: { messageId: "sent-1", threadId: THREAD } });
    expect(h.provider.send).toHaveBeenCalledTimes(1);
    expect(h.provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "alice@example.com", subject: "Hello", text: "hi" }),
    );
  });

  it("sends to the guardian alias and returns the provider receipt", async () => {
    const h = await harness();

    await expect(
      executeSendMessage(h.channels, { channel: "email", to: "guardian", text: "hi" }, h.deps),
    ).resolves.toEqual({ status: "ok", data: { messageId: "sent-1", threadId: THREAD } });
    expect(h.provider.send).toHaveBeenCalledTimes(1);
    expect(h.provider.send).toHaveBeenCalledWith(expect.objectContaining({ to: GUARDIAN }));
  });

  it("replies by threadId alone on an outbound-only thread, targeting Rome's newest send", async () => {
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

  it("keeps replying to the inbound message after Rome's own replies on that thread", async () => {
    const h = await harness({
      getMessage: rs.fn(async () => {
        throw new Error("body unavailable; the adapter falls back to the preview");
      }),
    });
    const raw = inboundEvent("in-1");
    await expect(h.adapter.ingestInbound(raw, sign(raw))).resolves.toMatchObject({
      status: "dispatched",
    });

    for (const [index, text] of ["first reply", "second reply"].entries()) {
      await expect(
        executeSendMessage(h.channels, { channel: "email", threadId: THREAD, text }, h.deps),
      ).resolves.toEqual({
        status: "ok",
        data: { messageId: `sent-${index + 1}`, threadId: THREAD },
      });
    }
    expect(h.provider.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ inReplyToMessageId: "in-1", text: "first reply" }),
    );
    expect(h.provider.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inReplyToMessageId: "in-1", text: "second reply" }),
    );
    expect(h.provider.listMessages).not.toHaveBeenCalled();

    const next = inboundEvent("in-2");
    await h.adapter.ingestInbound(next, sign(next));
    await executeSendMessage(h.channels, { channel: "email", threadId: THREAD, text: "third" });
    expect(h.provider.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ inReplyToMessageId: "in-2" }),
    );
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

  it("prefers the newest inbound message after restart over Rome's newer sends", async () => {
    const h = await harness({
      listMessages: rs.fn(async () => ({
        messages: [
          listItem("rome-reply-2"),
          listItem("other-inbound", ["received"], "other-thread"),
          listItem("rome-reply-1"),
          listItem("in-1", ["received", "unread"]),
          listItem("rome-first"),
        ],
      })),
    });

    for (const text of ["after restart", "again"]) {
      await expect(
        executeSendMessage(h.channels, { channel: "email", threadId: THREAD, text }, h.deps),
      ).resolves.toMatchObject({ status: "ok", data: { threadId: THREAD } });
    }
    expect(h.provider.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ inReplyToMessageId: "in-1", text: "after restart" }),
    );
    expect(h.provider.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inReplyToMessageId: "in-1", text: "again" }),
    );
    expect(h.provider.listMessages).toHaveBeenCalledTimes(1);
  });

  it("moves an outbound-only thread's target to Rome's newest send after a lookup", async () => {
    const h = await harness({
      listMessages: rs.fn(async () => ({ messages: [listItem("persisted-send")] })),
    });

    for (const text of ["after restart", "again"]) {
      await executeSendMessage(h.channels, { channel: "email", threadId: THREAD, text }, h.deps);
    }
    expect(h.provider.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ inReplyToMessageId: "persisted-send" }),
    );
    expect(h.provider.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inReplyToMessageId: "sent-1" }),
    );
    expect(h.provider.listMessages).toHaveBeenCalledTimes(1);
  });

  it("still finds the inbound message after an explicit reply on an uncached thread", async () => {
    const h = await harness({
      listMessages: rs.fn(async () => ({
        messages: [listItem("sent-1"), listItem("in-1", ["received"])],
      })),
    });

    await executeSendMessage(
      h.channels,
      { channel: "email", threadId: THREAD, replyToMessageId: "in-1", text: "explicit" },
      h.deps,
    );
    await executeSendMessage(
      h.channels,
      { channel: "email", threadId: THREAD, text: "thread only" },
      h.deps,
    );

    expect(h.provider.listMessages).toHaveBeenCalledTimes(1);
    expect(h.provider.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inReplyToMessageId: "in-1", text: "thread only" }),
    );
  });

  it("prefers an inbound that arrives during the lookup over an older one it finds", async () => {
    let releasePage: (page: { messages: RomeMailListItem[] }) => void = () => undefined;
    const h = await harness({
      listMessages: rs.fn(
        () =>
          new Promise<{ messages: RomeMailListItem[] }>((resolve) => {
            releasePage = resolve;
          }),
      ),
    });

    const reply = executeSendMessage(
      h.channels,
      { channel: "email", threadId: THREAD, text: "first" },
      h.deps,
    );
    await rs.waitFor(() => expect(h.provider.listMessages).toHaveBeenCalledTimes(1));
    const raw = inboundEvent("in-2");
    await h.adapter.ingestInbound(raw, sign(raw));
    releasePage({ messages: [listItem("in-1", ["received"])] });
    await reply;
    await executeSendMessage(h.channels, { channel: "email", threadId: THREAD, text: "second" });

    expect(h.provider.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ inReplyToMessageId: "in-2", text: "first" }),
    );
    expect(h.provider.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inReplyToMessageId: "in-2", text: "second" }),
    );
  });

  it("uses an inbound that arrives during a lookup when the lookup then fails", async () => {
    let failPage: (err: Error) => void = () => undefined;
    const h = await harness({
      listMessages: rs.fn(
        () =>
          new Promise<{ messages: RomeMailListItem[] }>((_resolve, reject) => {
            failPage = reject;
          }),
      ),
    });

    const reply = executeSendMessage(
      h.channels,
      { channel: "email", threadId: THREAD, text: "reply" },
      h.deps,
    );
    await rs.waitFor(() => expect(h.provider.listMessages).toHaveBeenCalledTimes(1));
    const raw = inboundEvent("in-2");
    await h.adapter.ingestInbound(raw, sign(raw));
    failPage(new Error("mail list unavailable"));

    await expect(reply).resolves.toMatchObject({ status: "ok" });
    expect(h.provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyToMessageId: "in-2" }),
    );
  });

  it("uses an inbound that arrives during a lookup when the lookup then times out", async () => {
    rs.useFakeTimers();
    try {
      const h = await harness({ listMessages: rs.fn(() => new Promise<never>(() => undefined)) });

      const reply = executeSendMessage(
        h.channels,
        { channel: "email", threadId: THREAD, text: "reply" },
        h.deps,
      );
      await rs.advanceTimersByTimeAsync(1);
      expect(h.provider.listMessages).toHaveBeenCalledTimes(1);
      const raw = inboundEvent("in-2");
      await h.adapter.ingestInbound(raw, sign(raw));
      await rs.advanceTimersByTimeAsync(REPLY_LOOKUP_BUDGET_MS);

      await expect(reply).resolves.toMatchObject({ status: "ok" });
      expect(h.provider.send).toHaveBeenCalledWith(
        expect.objectContaining({ inReplyToMessageId: "in-2" }),
      );
    } finally {
      rs.useRealTimers();
    }
  });

  it("does not cache a sent fallback from a lookup cut short by a failed page", async () => {
    const listMessages = rs
      .fn<MailProvider["listMessages"]>()
      .mockResolvedValueOnce({ messages: [listItem("rome-sent")], nextPageToken: "page-2" })
      .mockRejectedValueOnce(new Error("mail list unavailable"))
      .mockResolvedValueOnce({ messages: [listItem("rome-sent"), listItem("in-1", ["received"])] });
    const h = await harness({ listMessages });

    for (const text of ["first", "second"]) {
      await executeSendMessage(h.channels, { channel: "email", threadId: THREAD, text }, h.deps);
    }

    expect(h.provider.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ inReplyToMessageId: "rome-sent", text: "first" }),
    );
    expect(h.provider.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inReplyToMessageId: "in-1", text: "second" }),
    );
    expect(listMessages).toHaveBeenCalledTimes(3);
  });

  it("uses an explicit reply message before cached state or mailbox lookup", async () => {
    const h = await harness();
    await executeSendMessage(h.channels, { channel: "email", to: "guardian", text: "first" });
    await expect(
      executeSendMessage(h.channels, {
        channel: "email",
        threadId: THREAD,
        replyToMessageId: "explicit",
        text: "reply",
      }),
    ).resolves.toEqual({ status: "ok", data: { messageId: "sent-2", threadId: THREAD } });

    expect(h.provider.send).toHaveBeenCalledTimes(2);
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
      expect(h.ensureChannelChat).not.toHaveBeenCalled();
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
      expect(h.ensureChannelChat).not.toHaveBeenCalled();
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
    expect(failed.ensureChannelChat).not.toHaveBeenCalled();
    expect(failed.recordOutboundMessage).not.toHaveBeenCalled();
    await expect(failed.adapter.send(THREAD as ChatId, { text: "reply" })).rejects.toThrow(
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
      expect(h.ensureChannelChat).not.toHaveBeenCalled();
      expect(h.recordOutboundMessage).not.toHaveBeenCalled();
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

describe("email thread lookup under the channel-send RPC deadline", () => {
  const originalSend = process.send;
  const PAGE_MS = 4_000;

  afterEach(() => {
    rs.useRealTimers();
    process.send = originalSend;
    setWorkerRpcInProcessDispatcher(null);
  });

  // Route the action through the worker proxy, so `channels.send` runs under
  // the deadline an action worker applies to it.
  async function throughRpc(provider: Partial<MailProvider>) {
    const h = await harness(provider);
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async (method, params) => {
      if (method === "channels.list") return [{ name: "email", sendable: true }];
      if (method !== "channels.send") throw new Error(`unexpected RPC ${method}`);
      const { conversationId, message } = params as {
        conversationId: ChatId;
        message: Parameters<ChannelsService["send"]>[2];
      };
      return h.adapter.send(conversationId, message);
    });
    return { ...h, channels: new ChannelsServiceProxy() };
  }

  function after<T>(ms: number, value: T): Promise<T> {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
  }

  it("leaves room for the provider send inside the RPC deadline", () => {
    expect(REPLY_LOOKUP_BUDGET_MS).toBeGreaterThan(0);
    expect(REPLY_LOOKUP_BUDGET_MS + MAIL_REQUEST_TIMEOUT_MS).toBeLessThan(DEFAULT_RPC_TIMEOUT_MS);
  });

  it("fails a slow cache-miss lookup with no email sent, before the RPC times out", async () => {
    rs.useFakeTimers();
    let page = 0;
    const h = await throughRpc({
      listMessages: rs.fn(() => {
        page += 1;
        return after(PAGE_MS, {
          messages: [listItem(`other-${page}`, ["received"], "other-thread")],
          nextPageToken: `page-${page}`,
        });
      }),
    });

    const outcome = executeSendMessage(
      h.channels,
      { channel: "email", threadId: THREAD, text: "reply" },
      h.deps,
    ).then(
      () => new Error("expected the send to fail"),
      (err: unknown) => err,
    );
    await rs.advanceTimersByTimeAsync(DEFAULT_RPC_TIMEOUT_MS * 3);
    const error = await outcome;

    expect(error).not.toBeInstanceOf(IpcRpcTimeoutError);
    expect(String(error)).toContain("No email was sent");
    expect(h.provider.send).not.toHaveBeenCalled();
    expect(h.provider.listMessages).toHaveBeenCalledTimes(
      Math.ceil(REPLY_LOOKUP_BUDGET_MS / PAGE_MS),
    );
    expect(h.recordOutboundMessage).not.toHaveBeenCalled();
  });

  it("finishes a slow lookup and a slow provider send inside the RPC deadline", async () => {
    rs.useFakeTimers();
    let page = 0;
    const h = await throughRpc({
      listMessages: rs.fn(() => {
        page += 1;
        return after(PAGE_MS, {
          messages: [page === 2 ? listItem("in-1", ["received"]) : listItem("x", [], "other")],
          nextPageToken: `page-${page}`,
        });
      }),
      send: rs.fn(() =>
        after(MAIL_REQUEST_TIMEOUT_MS - 1, { messageId: "sent-1", threadId: THREAD }),
      ),
    });

    const outcome = executeSendMessage(
      h.channels,
      { channel: "email", threadId: THREAD, text: "reply" },
      h.deps,
    );
    await rs.advanceTimersByTimeAsync(DEFAULT_RPC_TIMEOUT_MS - 1);

    await expect(outcome).resolves.toEqual({
      status: "ok",
      data: { messageId: "sent-1", threadId: THREAD },
    });
    expect(h.provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyToMessageId: "in-1" }),
    );
  });

  it("replies to Rome's own message when the budget ends before any inbound turns up", async () => {
    rs.useFakeTimers();
    let page = 0;
    const h = await throughRpc({
      listMessages: rs.fn(() => {
        page += 1;
        return after(PAGE_MS, {
          messages: [page === 1 ? listItem("rome-sent") : listItem("x", [], "other")],
          nextPageToken: `page-${page}`,
        });
      }),
    });

    const outcome = executeSendMessage(
      h.channels,
      { channel: "email", threadId: THREAD, text: "reply" },
      h.deps,
    );
    await rs.advanceTimersByTimeAsync(REPLY_LOOKUP_BUDGET_MS);

    await expect(outcome).resolves.toEqual({
      status: "ok",
      data: { messageId: "sent-1", threadId: THREAD },
    });
    expect(h.provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyToMessageId: "rome-sent" }),
    );
  });
});
