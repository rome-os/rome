// Transport for Rome's own Discord bot. Channel contract:
// docs/architecture/channels.md.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import { createLogger } from "../../../logger.js";
import type { Message } from "../../message.js";
import { refuseAttachments, replyToShaped, textToSend } from "../../outbound/send-refusals.js";
import { discordAttachment } from "../discord/discord-attachment.js";
import { discordInboundText, splitMessage } from "../discord/discord.js";
import type { DiscordAppCloud } from "./worker.js";

const log = createLogger("discord-app");

/** The headers the Worker stamps on a deposit. */
export const DISCORD_DEPOSIT_HEADER = "x-rome-discord";
export const DISCORD_SIGNATURE_HEADER = "x-rome-discord-signature";

const SNOWFLAKE = /^\d{1,20}$/;

/** One message as the Worker deposits it (rome-cloud docs/discord-gateway.md). */
export interface DiscordAppDeposit {
  id: string;
  channelId: string;
  serverId?: string;
  parentId?: string;
  serverName: string;
  channelName: string;
  sender: { id: string; username?: string; globalName?: string | null };
  content: string;
  referencedMessageId?: string;
  attachments?: Array<{ url: string; filename?: string; contentType?: string; size?: number }>;
  ts: string;
}

/** Whether `signature` is the Worker's: hex HMAC-SHA256 of the exact body,
 *  keyed with the deposit key's text. */
export function isSignedBy(body: Uint8Array, signature: string, depositKey: string): boolean {
  const expected = Buffer.from(createHmac("sha256", depositKey).update(body).digest("hex"));
  const received = Buffer.from(signature.trim().toLowerCase());
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function isDeposit(value: unknown): value is DiscordAppDeposit {
  const deposit = value as Partial<DiscordAppDeposit> | null;
  return (
    typeof deposit?.id === "string" &&
    SNOWFLAKE.test(deposit.id) &&
    typeof deposit.channelId === "string" &&
    SNOWFLAKE.test(deposit.channelId) &&
    typeof deposit.sender?.id === "string" &&
    SNOWFLAKE.test(deposit.sender.id) &&
    typeof deposit.content === "string"
  );
}

/**
 * The connection's `Message` for `deposit`, heard by the bot `botId`. Platform
 * facts only. The Worker forwards a message in a server only when it mentions
 * the bot, so a server message names the bot's account among its mentions.
 */
export function messageOf(deposit: DiscordAppDeposit, botId: string, botName: string): Message {
  const direct = deposit.serverId === undefined;
  const saidAt = new Date(deposit.ts);
  return {
    id: deposit.id,
    where: {
      chatId: deposit.channelId as ChatId,
      kind: direct ? "direct" : "group",
      ...(!direct && deposit.channelName ? { name: deposit.channelName } : {}),
      // A Discord thread is a chat of its own, opened under a channel.
      ...(deposit.parentId ? { thread: { parentChatId: deposit.parentId as ChatId } } : {}),
    },
    sender: {
      accountId: deposit.sender.id,
      ...(deposit.sender.globalName || deposit.sender.username
        ? { name: deposit.sender.globalName || deposit.sender.username }
        : {}),
      ...(deposit.sender.username ? { handle: deposit.sender.username } : {}),
    },
    content: {
      text: discordInboundText(deposit.content, (id) => (id === botId ? botName : undefined)),
      attachments: (deposit.attachments ?? []).map((attachment) =>
        discordAttachment({
          url: attachment.url,
          name: attachment.filename ?? null,
          contentType: attachment.contentType ?? null,
        }),
      ),
    },
    receivedBy: botId,
    mentions: direct ? [] : [botId],
    ...(deposit.referencedMessageId ? { replyTo: { messageId: deposit.referencedMessageId } } : {}),
    saidAt: Number.isNaN(saidAt.getTime()) ? new Date() : saidAt,
    raw: deposit,
  };
}

export interface DiscordAppAdapterConfig {
  botId: string;
  botUsername: string;
  depositKey: string;
  cloud: DiscordAppCloud;
}

/** What a frame came to, as the drain reads an HTTP status. */
export interface IngestResult {
  status: number;
}

export class DiscordAppAdapter {
  private deliver?: (message: Message) => void;

  constructor(private readonly config: DiscordAppAdapterConfig) {}

  start(deliver: (message: Message) => void): void {
    this.deliver = deliver;
  }

  stop(): void {
    this.deliver = undefined;
  }

  /**
   * One drained frame. 401 for a frame the Worker did not sign for this
   * instance and 400 for one that is no message, both dropped for good. Every
   * other frame answers 200, also when Rome could not take its message (not
   * started): that is logged, and the mailbox is
   * never asked to deliver it again.
   */
  async ingest(body: Uint8Array, signature: string): Promise<IngestResult> {
    if (!signature || !isSignedBy(body, signature, this.config.depositKey)) {
      log.warn("discord frame dropped: not signed for this Rome");
      return { status: 401 };
    }
    let deposit: unknown;
    try {
      const raw = JSON.parse(new TextDecoder().decode(body));
      // Worker v2 uses sender so a v1 instance refuses it instead of linking everyone as guardian.
      // Reading a v1 deposit here is safe: this adapter never changes People.
      deposit = raw && typeof raw === "object" ? { ...raw, sender: raw.sender ?? raw.author } : raw;
    } catch {
      return { status: 400 };
    }
    if (!isDeposit(deposit)) return { status: 400 };
    const deliver = this.deliver;
    if (!deliver) {
      log.error("discord message dropped: the connection is not running", { id: deposit.id });
      return { status: 200 };
    }
    try {
      deliver(messageOf(deposit, this.config.botId, this.config.botUsername));
    } catch (error) {
      log.error("discord message dropped: Rome could not take it", {
        id: deposit.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { status: 200 };
  }

  /** Shows the bot typing in `chatId`. Discord drops it after about ten
   *  seconds, or when the bot posts. */
  async showTyping(chatId: ChatId): Promise<void> {
    await this.config.cloud.typing(chatId);
  }

  /** Reacts to message `messageId` in `chatId` with `emoji`, as the bot. */
  async react(chatId: ChatId, messageId: string, emoji: string): Promise<void> {
    if (!SNOWFLAKE.test(messageId)) {
      throw new Error(
        `Discord cannot react to message "${messageId}": it is not a Discord message id`,
      );
    }
    await this.config.cloud.react({ channelId: chatId, messageId, emoji });
  }

  /** Takes the bot's own reaction `emoji` off message `messageId` in `chatId`. */
  async unreact(chatId: ChatId, messageId: string, emoji: string): Promise<void> {
    if (!SNOWFLAKE.test(messageId)) return;
    await this.config.cloud.unreact({ channelId: chatId, messageId, emoji });
  }

  /** Posts `message` as the bot, in parts of at most 2000 characters; the
   *  first part replies to the message it answers. */
  async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageReceipt> {
    refuseAttachments("Discord", message);
    const text = textToSend("Discord", message).trim();
    const replyTo = replyToShaped("Discord", message.replyToMessageId, SNOWFLAKE);
    let first: string | undefined;
    for (const chunk of splitMessage(text)) {
      const sent = await this.config.cloud.send({
        channelId: chatId,
        content: chunk,
        ...(first === undefined && replyTo ? { replyTo } : {}),
      });
      first ??= sent.id;
    }
    return { chatId, ...(first ? { messageId: first } : {}) };
  }
}
