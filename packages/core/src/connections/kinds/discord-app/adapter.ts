// Transport for Rome's own Discord bot. Channel contract:
// docs/architecture/channels.md.
//
// One bot serves every Rome, so Discord's Gateway connects to the Discord
// gateway Worker, not to the instance. The Worker keeps only messages from the
// Discord accounts the guardian bound to this instance, and deposits each one,
// signed with this instance's deposit key, into the instance's relay mailbox.
// The mailbox's drain hands each frame here: the signature is checked, the
// author is the guardian's account, and the message is handed to Rome. Every
// frame the Worker signed is acknowledged, whatever happens to it here: the
// mailbox is shared with the instance's other webhooks, and a failure of ours
// is logged, never handed back to it. A message lost to a crash between the
// acknowledgement and its record is the accepted cost. Chats records a
// redelivered message once. Replies go to the Worker, which posts them as the bot.

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
  author: { id: string; username?: string; globalName?: string | null };
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
    typeof deposit.author?.id === "string" &&
    SNOWFLAKE.test(deposit.author.id) &&
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
      accountId: deposit.author.id,
      ...(deposit.author.globalName || deposit.author.username
        ? { name: deposit.author.globalName || deposit.author.username }
        : {}),
      ...(deposit.author.username ? { handle: deposit.author.username } : {}),
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
  /** Puts a Discord account under the guardian in People, unless People
   *  already places it. The Worker forwards only accounts the guardian bound
   *  while signed in to this Rome's account. */
  linkGuardian: (userId: string) => Promise<void>;
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
   * started, the author's link failed): that is logged, and the mailbox is
   * never asked to deliver it again.
   */
  async ingest(body: Uint8Array, signature: string): Promise<IngestResult> {
    if (!signature || !isSignedBy(body, signature, this.config.depositKey)) {
      log.warn("discord frame dropped: not signed for this Rome");
      return { status: 401 };
    }
    let deposit: unknown;
    try {
      deposit = JSON.parse(new TextDecoder().decode(body));
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
      await this.config.linkGuardian(deposit.author.id);
    } catch (error) {
      // The message still reaches Rome; People reads its author as it stands.
      log.error("discord author not linked to the guardian", {
        error: error instanceof Error ? error.message : String(error),
      });
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
