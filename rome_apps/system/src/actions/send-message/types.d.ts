/**
 * send_message — Send a message through any registered channel adapter.
 *
 * Agent-callable action. Agents invoke this via tool use to send outbound messages.
 * Can also be called directly from other actions via `executeSendMessage()` or
 * `callAction("send_message", input)`.
 *
 * @example
 * // Via callAction (from another action)
 * await callAction("send_message", {
 *   channel: "discord",
 *   threadId: "123456",
 *   text: "Hello!",
 * });
 *
 * // Via direct function call from the local action module
 * import { executeSendMessage } from "./index.js";
 * await executeSendMessage(channels, {
 *   channel: "discord",
 *   threadId: "123456",
 *   text: "Hello!",
 * });
 */

import type { MessagePart } from "@rome-os/app-runtime";

export interface SendMessageAttachment {
  /** Attachment media type. */
  type: "image" | "video" | "audio" | "document";
  /**
   * Absolute local path to the attachment. Must resolve under a Rome project
   * workspace or channel attachment directory.
   */
  source: string;
  /** Optional caption for the attachment. */
  caption?: string;
}

/** Chat-style channels: addressed by a thread id, no email-specific fields. */
export type ChatChannel =
  | "telegram"
  | "telegram_user"
  | "whatsapp"
  | "wechat"
  | "discord"
  | "webchat"
  | "feishu"
  | "agents";

interface SendMessageBase {
  /** The message text to send (supports markdown). Optional when attachments are provided. */
  text?: string;
  /** Optional file attachments to send. */
  attachments?: SendMessageAttachment[];
  /**
   * Optional correlation id for the agent turn that produced this message.
   * Forwarded to the channel adapter via OutgoingMessage.turnId. Webchat
   * persists it on the stored row so concurrent turns can be grouped on
   * read; other channels currently ignore it. Not meant to be set by agent
   * tool calls — supplied by the orchestrating route/action.
   */
  turnId?: string;
  /**
   * Structured message parts (text with optional turnPhase/blockId/blockIx,
   * cards, …). When provided, rich-content channels (webchat) render/persist these instead of
   * the plain `text` path; other channels ignore them and fall back to `text`.
   * Supplied by the orchestrating route (e.g. the webchat turn finalizer that
   * persists in-turn commentary + final answer), not by agent tool calls — so
   * it is intentionally absent from the model-facing inputSchema.
   */
  parts?: MessagePart[];
  /** @internal Stable conversation resolved by the orchestrating path. */
  romeSessionId?: string;
  /** @internal The provider turn that already contains this message. */
  knownToProvider?: boolean;
}

export interface SendMessageChatInput extends SendMessageBase {
  channel: ChatChannel;
  /** The thread/chat ID to send the message to. Required unless `to: "guardian"` is used. */
  threadId?: string;
  /**
   * Recipient alias for chat channels: `"guardian"`, or on `agents` an agent's
   * name, which core resolves to the agent's id.
   */
  to?: string;
  /** The recipient user ID. Defaults to threadId if not provided. */
  channelUserId?: string;
  /** Optional message ID to reply to. */
  replyToMessageId?: string;
}

/**
 * Email send. The email channel's own fields live here, not on the
 * chat shape. Reply on an existing thread by passing `threadId` (or
 * `replyToMessageId`, the inbound provider message id); start a fresh email by
 * passing `to` (the literal `"guardian"` resolves to the guardian's address).
 */
export interface SendMessageEmailInput extends SendMessageBase {
  channel: "email";
  /** Recipient(s); `"guardian"` resolves to the guardian's address. Required for a new email. */
  to?: string | string[];
  /** Reply on this Rome/AgentMail thread when present; otherwise a new email. */
  threadId?: string;
  channelUserId?: string;
  subject?: string;
  cc?: string[];
  bcc?: string[];
  /** Raw HTML body (e.g. an app-generated report); sanitized before send. */
  html?: string;
  /** Inbound provider message id to reply to (keeps the thread). Equivalent to `replyToMessageId`. */
  replyToMessageId?: string;
}

export type SendMessageInput = SendMessageChatInput | SendMessageEmailInput;

export interface SendMessageOutput {
  status: "ok";
}
