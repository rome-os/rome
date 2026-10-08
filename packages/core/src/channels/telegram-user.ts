import { Api, TelegramClient } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/NewMessage.js";
import { StringSession } from "telegram/sessions/StringSession.js";
import type { ChannelMessage, ConversationId, MessageReceipt } from "@rome-os/app-runtime";
import type { Attachment, OutgoingMessage } from "./types.js";
import { createLogger } from "../logger.js";
import { readFile } from "node:fs/promises";
import {
  AttachmentTooLargeError,
  isAttachmentTooLargeError,
  MAX_ATTACHMENT_BYTES,
  saveIncomingAttachmentPayloads,
} from "./attachment-files.js";

const log = createLogger("telegram-user");
const TELEGRAM_USER_SETTINGS_KEY = "telegram_user";
type SimpleEntity = string | number;

/**
 * A connected Telegram user account — the full login output. Every field is a
 * credential (`apiId`/`apiHash`/`sessionString`), identity (`userId`/`username`/
 * `displayName`/`phoneNumber`), or the connect timestamp; there is no config, so
 * this is NEVER persisted to a settings row. The login ceremony
 * returns it to the route, which splits it into the grant's credential material
 * and profile and writes both into the ledger via a single `importCredential`.
 */
export interface TelegramUserSettings {
  apiId: number;
  apiHash: string;
  sessionString: string;
  phoneNumber: string;
  userId: string;
  username: string | null;
  displayName: string;
  connectedAt: string;
}

/** The outcome of submitting the phone code: the connected account, or a signal
 *  that Telegram two-step verification (2FA) is required (carrying its hint). */
export type TelegramUserLoginOutcome =
  | {
      status: "connected";
      /** The full connected account — the conferral setup turns it into the
       *  `session` grant's credential material + profile and writes both to the
       *  ledger in one terminal write. Carries secrets (`sessionString`/`apiHash`);
       *  only the non-secret identity ever crosses to a client. */
      account: TelegramUserSettings;
    }
  | {
      status: "password_required";
      passwordHint: string | null;
    };

/**
 * One in-flight interactive login, held for the lifetime of a conferral setup
 * coroutine: a single GramJS client + StringSession. The coroutine
 * holds exactly one handle in scope, so — unlike the retired route-era
 * `TelegramUserAuthService` — there is no attempt-id map and no `hasPendingLogin`
 * tracker; the setup session IS the pending-login state. Abandoning or cancelling
 * the setup calls `stop()`; nothing durable was ever written.
 */
export interface TelegramUserLoginHandle {
  /** Connect and request the phone code for `phoneNumber`. Returns whether
   *  Telegram delivered the code in-app (vs SMS). Throws `TelegramUserAuthError`
   *  when the request is refused. */
  sendCode(phoneNumber: string): Promise<{ isCodeViaApp: boolean }>;
  /** Submit the phone code. Resolves with the connected account, or signals that
   *  2FA is required. Throws `TelegramUserAuthError` on an invalid/expired code so
   *  the coroutine can re-prompt. */
  submitCode(code: string): Promise<TelegramUserLoginOutcome>;
  /** Submit the 2FA password. Resolves with the connected account; throws
   *  `TelegramUserAuthError` on a wrong password so the coroutine can re-prompt. */
  submitPassword(password: string): Promise<TelegramUserSettings>;
  /** Disconnect the pending client (idempotent). */
  stop(): Promise<void>;
}

/** Open a fresh interactive login over a throwaway client + empty session. */
export function openTelegramUserLogin(apiId: number, apiHash: string): TelegramUserLoginHandle {
  return new TelegramUserLogin(apiId, apiHash);
}

export interface TelegramUserDialogSummary {
  id: string;
  title: string;
  type: "private" | "group";
  unreadCount: number;
  archived: boolean;
  pinned: boolean;
}

export class TelegramUserAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** GramJS RPC error messages that mean the stored session is no longer valid —
 *  the account revoked it or the auth key was unregistered. The registry maps
 *  these (and any 401/UnauthorizedError) to a refused `session` credential. */
const TELEGRAM_USER_SESSION_REVOKED_MESSAGES = new Set([
  "AUTH_KEY_UNREGISTERED",
  "SESSION_REVOKED",
  "USER_DEACTIVATED",
  "AUTH_KEY_DUPLICATED",
]);

/**
 * True iff `err` signals a refused Telegram user session (GramJS 401
 * UnauthorizedError, an AUTH_KEY_UNREGISTERED / SESSION_REVOKED RPC error, or
 * the adapter's own "session is not authorized" guard). This is the ONLY
 * telegram_user signal that maps to grant state; every other
 * transport failure is a `Disconnected`.
 */
export function isTelegramUserSessionRejected(err: unknown): boolean {
  if (err instanceof TelegramUserSessionNotAuthorizedError) return true;
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 401) return true;
  const message = (err as { errorMessage?: unknown }).errorMessage;
  return typeof message === "string" && TELEGRAM_USER_SESSION_REVOKED_MESSAGES.has(message);
}

/** Thrown by {@link TelegramUserAdapter.start} when a connect succeeds but the
 *  stored session is no longer authorized — a refused `session` credential. */
export class TelegramUserSessionNotAuthorizedError extends Error {
  constructor() {
    super("Stored Telegram user session is not authorized");
    this.name = "TelegramUserSessionNotAuthorizedError";
  }
}

/**
 * The Telegram user-account transport. Inbound messages and history lines
 * arrive as the channel's own record, a `ChannelMessage` whose `raw` is the
 * GramJS `Api.Message`, so the Connection integration delivers them as they are.
 */
export class TelegramUserAdapter {
  private client: TelegramClient;
  private handler?: (msg: ChannelMessage) => Promise<void>;

  constructor(private settings: TelegramUserSettings) {
    this.client = createTelegramClient(settings.apiId, settings.apiHash, settings.sessionString);
  }

  async start(): Promise<void> {
    await this.client.connect();
    const authorized = await this.client.checkAuthorization();
    if (!authorized) {
      throw new TelegramUserSessionNotAuthorizedError();
    }

    this.client.addEventHandler(
      (event: NewMessageEvent) => {
        this.handleNewMessage(event).catch((err) => {
          log.error("telegram user message handler error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      new NewMessage({ incoming: true }),
    );
    log.info("telegram user adapter started", { userId: this.settings.userId });
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
  }

  /**
   * Probe the session's authorization on THIS adapter's already-connected client
   * (the session-health check folded into the Talk epoch). GramJS
   * user sessions die silently: the account can revoke the session server-side
   * while the socket stays open and no NewMessage ever arrives, so the epoch
   * polls `checkAuthorization` to surface the death. Throws
   * `TelegramUserSessionNotAuthorizedError` (→ CredentialRejected) when the
   * session was revoked; a network error propagates unchanged so the caller can
   * tell a refused credential (a fault) from a transient outage (not a fault).
   */
  async probe(): Promise<void> {
    const authorized = await this.client.checkAuthorization();
    if (!authorized) {
      throw new TelegramUserSessionNotAuthorizedError();
    }
  }

  async send(conversationId: ConversationId, message: OutgoingMessage): Promise<MessageReceipt> {
    const threadId: string = conversationId;
    const entity = entityFromThreadId(threadId);
    const replyTo = message.replyToMessageId
      ? Number.parseInt(message.replyToMessageId, 10)
      : undefined;

    let messageId: string | undefined;
    if (message.text) {
      const sent = await this.client.sendMessage(entity, {
        message: message.text,
        replyTo: Number.isFinite(replyTo) ? replyTo : undefined,
      });
      messageId = String(sent.id);
    }

    for (const attachment of message.attachments ?? []) {
      await this.client.sendMessage(entity, {
        message: attachment.caption,
        file: attachment.source,
      });
    }

    log.info("telegram user message sent", { threadId });
    return { conversationId, ...(messageId ? { messageId } : {}) };
  }

  onInbound(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** Download a message's media into the profile. The media lives on the
   *  GramJS `Api.Message` in `raw`, so a message without one keeps its
   *  attachments as they are. Only the first attachment is saved, because a
   *  GramJS message carries one media payload. */
  async saveIncomingAttachments(message: ChannelMessage): Promise<Attachment[]> {
    const event = message.raw;
    if (message.attachments.length === 0 || !(event instanceof Api.Message)) {
      return message.attachments;
    }

    const expectedBytes = telegramUserMediaSizeBytes(event);
    if (expectedBytes !== undefined && expectedBytes > MAX_ATTACHMENT_BYTES) {
      log.warn("telegram user attachment too large, skipping save", {
        messageId: message.messageId,
        bytes: expectedBytes,
      });
      return message.attachments;
    }

    let downloaded: string | Buffer | undefined;
    try {
      downloaded = await this.client.downloadMedia(event, {
        progressCallback(downloadedBytes) {
          const bytes = numericTelegramSize(downloadedBytes);
          if (bytes !== undefined && bytes > MAX_ATTACHMENT_BYTES) {
            throw new AttachmentTooLargeError(bytes);
          }
        },
      });
    } catch (err) {
      if (!isAttachmentTooLargeError(err)) throw err;
      log.warn("telegram user attachment too large, skipping save", {
        messageId: message.messageId,
        bytes: err.bytes,
      });
      return message.attachments;
    }
    if (!downloaded) return message.attachments;

    const data = Buffer.isBuffer(downloaded) ? downloaded : await readFile(downloaded);
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      log.warn("telegram user attachment too large, skipping save", {
        messageId: message.messageId,
        bytes: data.byteLength,
      });
      return message.attachments;
    }
    const attachment = message.attachments[0];
    if (!attachment) return message.attachments;
    if (message.attachments.length > 1) {
      log.warn("telegram user message has additional attachments without separate media payloads", {
        messageId: message.messageId,
        savedAttachments: 1,
        skippedAttachments: message.attachments.length - 1,
      });
    }

    return saveIncomingAttachmentPayloads(
      {
        channel: "telegram_user",
        threadId: message.conversationId,
        id: message.messageId,
        attachments: message.attachments,
      },
      [
        {
          attachment,
          data,
          mimeType: telegramUserMediaMimeType(event) ?? attachment.mimeType,
          fileName: telegramUserMediaFileName(event),
        },
      ],
    );
  }

  /** Messages from the last `windowHours`, oldest first: one conversation's
   *  last 100, or the last 50 of each of the first 50 dialogs when
   *  `threadId` is null. Every line is `direction: "inbound"`. Its `raw`
   *  `Api.Message` carries `out`, which tells the account's own lines apart. */
  async fetchHistory(threadId: string | null, windowHours: number): Promise<ChannelMessage[]> {
    const cutoffMs = Date.now() - windowHours * 60 * 60 * 1000;
    if (threadId) {
      const messages = await this.client.getMessages(entityFromThreadId(threadId), {
        limit: 100,
      });
      return messages
        .filter((message) => message instanceof Api.Message)
        .map((message) => this.normalizeMessage(message, { threadId }))
        .filter((message) => message.timestamp.getTime() >= cutoffMs)
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }

    const dialogs = await this.client.getDialogs({ limit: 50 });
    const allMessages: ChannelMessage[] = [];
    for (const dialog of dialogs) {
      const dialogId = dialog.id?.toString();
      if (!dialogId) continue;

      const messages = await this.client.getMessages(dialog.inputEntity, { limit: 50 });
      for (const message of messages) {
        if (!(message instanceof Api.Message)) continue;
        const normalized = this.normalizeMessage(message, {
          threadId: dialogId,
          threadName: dialog.title ?? dialog.name,
          threadType: dialog.isUser ? "private" : "group",
        });
        if (normalized.timestamp.getTime() >= cutoffMs) {
          allMessages.push(normalized);
        }
      }
    }

    return allMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  async listDialogs(limit = 50): Promise<TelegramUserDialogSummary[]> {
    const dialogs = await this.client.getDialogs({ limit });
    return dialogs
      .map((dialog) => ({
        id: dialog.id?.toString() ?? "",
        title: dialog.title ?? dialog.name ?? dialog.id?.toString() ?? "Untitled chat",
        type: dialog.isUser ? ("private" as const) : ("group" as const),
        unreadCount: dialog.unreadCount,
        archived: dialog.archived,
        pinned: dialog.pinned,
      }))
      .filter((dialog) => dialog.id.length > 0);
  }

  private async handleNewMessage(event: NewMessageEvent): Promise<void> {
    if (!this.handler) return;
    await this.handler(this.normalizeMessage(event.message));
  }

  private normalizeMessage(
    message: Api.Message,
    context: {
      threadId?: string;
      threadName?: string;
      threadType?: "private" | "group";
    } = {},
  ): ChannelMessage {
    const threadId = context.threadId ?? peerToThreadId(message.peerId);
    const fromId = message.fromId ? peerToThreadId(message.fromId) : threadId;
    const isOutgoing = message.out === true;
    return {
      channel: "telegram_user",
      direction: "inbound",
      messageId: String(message.id),
      conversationId: threadId as ConversationId,
      senderId: isOutgoing ? this.settings.userId : fromId,
      senderDisplayName: isOutgoing ? this.settings.displayName : (context.threadName ?? fromId),
      text: message.message ?? "",
      attachments: extractTelegramAttachments(message.media),
      timestamp: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000),
      ...(message.replyTo?.replyToMsgId
        ? { replyTo: { messageId: String(message.replyTo.replyToMsgId) } }
        : {}),
      // A live message carries no dialog context, so it reads as a group even
      // in a private chat. Only the all-dialogs history read knows a line's kind.
      thread: {
        kind: context.threadType === "private" ? "dm" : "group",
        ...(context.threadName ? { name: context.threadName } : {}),
      },
      raw: message,
    };
  }
}

/**
 * The interactive-login implementation behind {@link openTelegramUserLogin}: one
 * throwaway GramJS client + StringSession driven by the conferral setup coroutine.
 * `sendCode` connects and requests the phone code; `submitCode` /
 * `submitPassword` complete the phone-code + optional 2FA handshake and serialize
 * the authorized session into a {@link TelegramUserSettings} account. The
 * coroutine's terminal return is the single durable write, so this class NEVER
 * touches the ledger or any settings row.
 */
class TelegramUserLogin implements TelegramUserLoginHandle {
  private readonly client: TelegramClient;
  private readonly session: StringSession;
  private phoneNumber = "";
  private phoneCodeHash = "";

  constructor(
    private readonly apiId: number,
    private readonly apiHash: string,
  ) {
    const created = createTelegramClientWithSession(apiId, apiHash, "");
    this.client = created.client;
    this.session = created.session;
  }

  async sendCode(phoneNumber: string): Promise<{ isCodeViaApp: boolean }> {
    this.phoneNumber = phoneNumber;
    try {
      await this.client.connect();
      const code = await this.client.sendCode(
        { apiId: this.apiId, apiHash: this.apiHash },
        phoneNumber,
      );
      this.phoneCodeHash = code.phoneCodeHash;
      return { isCodeViaApp: code.isCodeViaApp };
    } catch (err) {
      await this.stop();
      throw toTelegramUserAuthError(err, "Failed to start Telegram user login");
    }
  }

  async submitCode(code: string): Promise<TelegramUserLoginOutcome> {
    try {
      const result = await this.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: this.phoneNumber,
          phoneCodeHash: this.phoneCodeHash,
          phoneCode: code,
        }),
      );

      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        throw new TelegramUserAuthError("Telegram signup is not supported by Rome", 400);
      }

      return { status: "connected", account: this.finalize(result.user) };
    } catch (err) {
      if (isTelegramError(err, "SESSION_PASSWORD_NEEDED")) {
        const password = await this.client.invoke(new Api.account.GetPassword());
        return { status: "password_required", passwordHint: password.hint ?? null };
      }
      throw toTelegramUserAuthError(err, "Failed to complete Telegram user login");
    }
  }

  async submitPassword(password: string): Promise<TelegramUserSettings> {
    let lastPasswordError: Error | null = null;
    try {
      const user = await this.client.signInWithPassword(
        { apiId: this.apiId, apiHash: this.apiHash },
        {
          password: async () => password,
          onError: (err) => {
            lastPasswordError = err;
            log.warn("telegram user password login failed", { error: safeErrorMessage(err) });
            // Returning false tells GramJS not to retry the same static password —
            // the coroutine re-prompts for a fresh one instead.
            return Promise.resolve(false);
          },
        },
      );
      return this.finalize(user);
    } catch (err) {
      throw toTelegramUserAuthError(
        lastPasswordError ?? err,
        "Failed to complete Telegram user 2FA login",
      );
    }
  }

  async stop(): Promise<void> {
    try {
      await this.client.disconnect();
    } catch (err) {
      log.warn("telegram client disconnect failed", { error: safeErrorMessage(err) });
    }
  }

  /** Serialize the authorized client + session into the connected-account payload
   *  the terminal conferral records (credential material + profile). */
  private finalize(user: Api.TypeUser): TelegramUserSettings {
    if (!(user instanceof Api.User)) {
      throw new TelegramUserAuthError("Telegram login did not return a user account");
    }
    const names = [user.firstName, user.lastName].filter(Boolean);
    return {
      apiId: this.apiId,
      apiHash: this.apiHash,
      sessionString: this.session.save(),
      phoneNumber: this.phoneNumber,
      connectedAt: new Date().toISOString(),
      userId: user.id.toString(),
      username: user.username ? `@${user.username}` : null,
      displayName: names.length > 0 ? names.join(" ") : (user.username ?? user.id.toString()),
    };
  }
}

function toTelegramUserAuthError(
  err: unknown,
  fallback: string,
  statusCode = 400,
): TelegramUserAuthError {
  if (err instanceof TelegramUserAuthError) return err;
  const message = safeErrorMessage(err);
  return new TelegramUserAuthError(message || fallback, statusCode);
}

export function telegramUserSettingsKey(): string {
  return TELEGRAM_USER_SETTINGS_KEY;
}

function createTelegramClient(
  apiId: number,
  apiHash: string,
  sessionString: string,
): TelegramClient {
  return createTelegramClientWithSession(apiId, apiHash, sessionString).client;
}

function createTelegramClientWithSession(
  apiId: number,
  apiHash: string,
  sessionString: string,
): { client: TelegramClient; session: StringSession } {
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });
  return { client, session };
}

function entityFromThreadId(threadId: string): SimpleEntity {
  if (/^-?\d+$/.test(threadId)) {
    const value = Number(threadId);
    if (Number.isSafeInteger(value)) return value;
  }
  return threadId;
}

function peerToThreadId(peer: Api.TypePeer | undefined): string {
  if (peer instanceof Api.PeerUser) {
    return peer.userId.toString();
  }
  if (peer instanceof Api.PeerChat) {
    return `-${peer.chatId.toString()}`;
  }
  if (peer instanceof Api.PeerChannel) {
    return `-100${peer.channelId.toString()}`;
  }
  return "unknown";
}

function extractTelegramAttachments(media: Api.TypeMessageMedia | undefined): Attachment[] {
  if (!media) return [];
  if (media instanceof Api.MessageMediaPhoto) {
    return [{ type: "image" }];
  }
  if (media instanceof Api.MessageMediaDocument) {
    if (media.video || media.round) return [{ type: "video" }];
    if (media.voice) return [{ type: "audio" }];
    return [{ type: "document" }];
  }
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive) {
    return [{ type: "location" }];
  }
  if (media instanceof Api.MessageMediaContact) {
    return [{ type: "contact" }];
  }
  return [];
}

function telegramUserMediaMimeType(message: Api.Message): string | undefined {
  const media = message.media;
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    return media.document.mimeType;
  }
  return undefined;
}

function telegramUserMediaFileName(message: Api.Message): string | undefined {
  const media = message.media;
  if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) {
    return undefined;
  }
  const attr = media.document.attributes.find(
    (value): value is Api.DocumentAttributeFilename =>
      value instanceof Api.DocumentAttributeFilename,
  );
  return attr?.fileName;
}

function telegramUserMediaSizeBytes(message: Api.Message): number | undefined {
  const media = message.media;
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    return numericTelegramSize(media.document.size);
  }
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
    return maxTelegramPhotoSize(media.photo.sizes);
  }
  return undefined;
}

function maxTelegramPhotoSize(sizes: Api.TypePhotoSize[] | undefined): number | undefined {
  const knownSizes = (sizes ?? [])
    .flatMap((size) => {
      const progressiveSizes = valueProperty(size, "sizes");
      if (Array.isArray(progressiveSizes)) return progressiveSizes;
      return [valueProperty(size, "size"), valueProperty(size, "bytes")];
    })
    .map(numericTelegramSize)
    .filter((size): size is number => size !== undefined);

  return knownSizes.length > 0 ? Math.max(...knownSizes) : undefined;
}

function valueProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null || !(property in value)) return undefined;
  return (value as Record<string, unknown>)[property];
}

function numericTelegramSize(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= 0n ? Number(value) : undefined;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
  }
  if (value instanceof Uint8Array) {
    return value.byteLength;
  }
  if (typeof value === "object" && value !== null) {
    const numeric = Number(String(value));
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
  }
  return undefined;
}

function isTelegramError(err: unknown, errorMessage: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "errorMessage" in err &&
    (err as { errorMessage?: unknown }).errorMessage === errorMessage
  );
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "errorMessage" in err) {
    const value = (err as { errorMessage?: unknown }).errorMessage;
    if (typeof value === "string") return value;
  }
  return String(err);
}
