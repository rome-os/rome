import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import { Api } from "telegram";
import { returnBigInt } from "telegram/Helpers.js";
import { openTelegramUserLogin, TelegramUserAdapter } from "./telegram-user.js";

// The GramJS client is the process edge: its signInWithPassword call shape is
// the outbound contract under test (onError returning false tells GramJS not
// to retry a static password). The interactive login (openTelegramUserLogin)
// holds one throwaway client + session; the test swaps a fake client onto the
// handle so submitPassword runs against it without dialing Telegram. The login
// writes nothing to disk (the connected account is the setup coroutine's
// terminal return, not a persisted row), so a rejected 2FA
// password rejects with the GramJS error and never yields an account.

type PasswordCallbacks = {
  password: () => Promise<string>;
  onError: (err: Error) => Promise<boolean>;
};

describe("TelegramUserLogin.submitPassword", () => {
  it("does not retry a static 2FA password after GramJS rejects it", async () => {
    const passwordError = new Error("PASSWORD_HASH_INVALID");
    let onErrorResult: unknown;
    const client = {
      signInWithPassword: rs
        .fn()
        .mockImplementation(async (_config: unknown, callbacks: PasswordCallbacks) => {
          expect(await callbacks.password()).toBe("bad-password");
          onErrorResult = await callbacks.onError(passwordError);
          throw passwordError;
        }),
    };

    // The handle builds its own client in the constructor; swap in the fake so
    // submitPassword exercises the GramJS call shape without a real connection.
    const login = openTelegramUserLogin(12345, "hash-secret") as unknown as {
      client: unknown;
      submitPassword: (password: string) => Promise<unknown>;
    };
    login.client = client;

    await expect(login.submitPassword("bad-password")).rejects.toMatchObject({
      message: "PASSWORD_HASH_INVALID",
    });

    expect(onErrorResult).toBe(false);
    expect(client.signInWithPassword).toHaveBeenCalledTimes(1);
  });
});

// The adapter's GramJS client is swapped for a fake the same way, and real
// `Api.Message` objects stand in for what GramJS hands the NewMessage handler,
// so the `instanceof Api.Message` guard on `raw` runs for real. Profile paths
// resolve through HOME/ROME_PROFILE env scoping.

const SETTINGS = {
  apiId: 12345,
  apiHash: "hash-secret",
  sessionString: "",
  phoneNumber: "+10000000000",
  userId: "42",
  username: "@me",
  displayName: "Me",
  connectedAt: "2026-01-01T00:00:00.000Z",
};

/** A channel post from user 111 that replies to message 5 and carries a PDF. */
function documentMessage(overrides: { out?: boolean } = {}): Api.Message {
  return new Api.Message({
    id: 7,
    peerId: new Api.PeerChannel({ channelId: returnBigInt(555) }),
    fromId: new Api.PeerUser({ userId: returnBigInt(111) }),
    date: 1_700_000_000,
    message: "see this",
    replyTo: new Api.MessageReplyHeader({ replyToMsgId: 5 }),
    media: new Api.MessageMediaDocument({
      document: new Api.Document({
        id: returnBigInt(1),
        accessHash: returnBigInt(2),
        fileReference: Buffer.alloc(0),
        date: 1_700_000_000,
        mimeType: "application/pdf",
        size: returnBigInt(4),
        dcId: 1,
        attributes: [new Api.DocumentAttributeFilename({ fileName: "a.pdf" })],
      }),
    }),
    ...overrides,
  });
}

describe("TelegramUserAdapter", () => {
  let adapter: TelegramUserAdapter;
  let internals: {
    client: unknown;
    handleNewMessage(event: { message: Api.Message }): Promise<void>;
  };
  let sandboxHome: string;

  beforeEach(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "rome-telegram-user-"));
    rs.stubEnv("HOME", sandboxHome);
    rs.stubEnv("ROME_PROFILE", "telegram-user-test");
    adapter = new TelegramUserAdapter(SETTINGS);
    internals = adapter as unknown as typeof internals;
  });

  afterEach(async () => {
    rs.unstubAllEnvs();
    await rm(sandboxHome, { recursive: true, force: true });
  });

  it("emits an inbound message as a ChannelMessage, field for field", async () => {
    const delivered: ChannelMessage[] = [];
    adapter.onInbound(async (msg) => {
      delivered.push(msg);
    });
    const message = documentMessage();
    await internals.handleNewMessage({ message });

    expect(delivered).toStrictEqual([
      {
        channel: "telegram_user",
        direction: "inbound",
        messageId: "7",
        conversationId: "-100555",
        senderId: "111",
        senderDisplayName: "111",
        text: "see this",
        attachments: [{ type: "document" }],
        timestamp: new Date(1_700_000_000_000),
        replyTo: { messageId: "5" },
        thread: { kind: "group" },
        raw: message,
      },
    ]);
    expect(delivered[0]?.raw).toBe(message);
  });

  it("answers a send with the conversation and the sent message id", async () => {
    const sendMessage = rs.fn().mockResolvedValue({ id: 99 });
    internals.client = { sendMessage };

    await expect(adapter.send("123" as ConversationId, { text: "hi" })).resolves.toStrictEqual({
      conversationId: "123",
      messageId: "99",
    });
    expect(sendMessage).toHaveBeenCalledWith(123, { message: "hi", replyTo: undefined });
  });

  it("answers an attachment-only send with no message id", async () => {
    internals.client = { sendMessage: rs.fn().mockResolvedValue({ id: 1 }) };

    await expect(
      adapter.send("123" as ConversationId, {
        attachments: [{ type: "document", source: "/tmp/a.pdf" }],
      }),
    ).resolves.toStrictEqual({ conversationId: "123" });
  });

  it("reads each dialog's history with its kind and name, own lines carrying `out`", async () => {
    const own = documentMessage({ out: true });
    internals.client = {
      getDialogs: async () => [
        { id: returnBigInt(111), inputEntity: "dm", title: "Alice", isUser: true },
      ],
      getMessages: async () => [own],
    };

    const lines = await adapter.fetchHistory(null, 24 * 365 * 100);
    expect(lines).toStrictEqual([
      {
        channel: "telegram_user",
        direction: "inbound",
        messageId: "7",
        conversationId: "111",
        senderId: "42",
        senderDisplayName: "Me",
        text: "see this",
        attachments: [{ type: "document" }],
        timestamp: new Date(1_700_000_000_000),
        replyTo: { messageId: "5" },
        thread: { kind: "dm", name: "Alice" },
        raw: own,
      },
    ]);
  });

  describe("saveIncomingAttachments", () => {
    function inbound(raw?: unknown): ChannelMessage {
      return {
        channel: "telegram_user",
        direction: "inbound",
        messageId: "7",
        conversationId: "-100555" as ConversationId,
        senderId: "111",
        text: "",
        attachments: [{ type: "document" }],
        timestamp: new Date(1_700_000_000_000),
        ...(raw === undefined ? {} : { raw }),
      };
    }

    it("downloads the media from the Api.Message in raw", async () => {
      const body = Buffer.from("%PDF");
      const downloadMedia = rs.fn().mockResolvedValue(body);
      internals.client = { downloadMedia };
      const message = documentMessage();

      const attachments = await adapter.saveIncomingAttachments(inbound(message));

      expect(downloadMedia).toHaveBeenCalledWith(message, expect.any(Object));
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.mimeType).toBe("application/pdf");
      expect(attachments[0]?.fileName).toBe("a.pdf");
      expect(attachments[0]?.localPath).toContain(sandboxHome);
      // safePathSegment drops the leading "-" from the chat id.
      expect(attachments[0]?.localPath).toContain(
        join("channel-attachments", "telegram_user", "100555", "7"),
      );
      await expect(readFile(attachments[0]!.localPath!)).resolves.toEqual(body);
    });

    it("keeps the attachments as they are when raw is missing or not an Api.Message", async () => {
      const downloadMedia = rs.fn();
      internals.client = { downloadMedia };

      const missing = inbound();
      await expect(adapter.saveIncomingAttachments(missing)).resolves.toBe(missing.attachments);
      const foreign = inbound({ id: 7, media: {} });
      await expect(adapter.saveIncomingAttachments(foreign)).resolves.toBe(foreign.attachments);
      expect(downloadMedia).not.toHaveBeenCalled();
    });
  });
});
