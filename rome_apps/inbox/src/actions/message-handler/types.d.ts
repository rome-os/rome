import type { MessageReplyReference } from "@rome-os/app-runtime";

/**
 * message_handler — Process an inbound message from a channel.
 *
 * Event-only action (no inputSchema). Triggered by ChannelMessageHook when a
 * message arrives on any connected channel. Routes through trusted/untrusted
 * paths based on the sender's bond level.
 *
 * Trusted path:  main agent processes -> envoy validates -> send (or approval gate)
 * Untrusted path: sentinel triages (REPLY/ESCALATE/IGNORE) -> logged
 *
 * @example
 * // Triggered internally by ChannelMessageHook — not called directly.
 * // The hook normalizes the channel message and passes it as:
 * await actionEngine.execute("message_handler", {
 *   channel: "telegram",
 *   channelUserId: "123456",
 *   threadId: "123456",
 *   threadName: "John Doe",
 *   threadType: "private",
 *   displayName: "John",
 *   text: "Hey, how are you?",
 *   attachments: [],
 *   messageId: "msg_abc",
 * });
 */

export interface MessageHandlerPersonOverride {
  id: string;
  displayName: string;
  channelMappings: {
    channel: string;
    channelUserId: string;
  }[];
  bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other";
  profilePath?: string;
  approved: boolean;
  createdAt: Date;
}

export interface MessageHandlerInput {
  /** Channel the message arrived on (e.g. "telegram", "whatsapp"). */
  channel: string;
  /** Channel-specific user ID of the sender. */
  channelUserId: string;
  /** Thread/chat ID where the message was received. */
  threadId: string;
  /** Parent chat id when threadId is a platform-native thread. */
  parentThreadId?: string;
  /** Display name of the thread (group name or contact name). */
  threadName: string;
  /** Thread type: "private", "group", etc. */
  threadType: string;
  /** Display name of the sender. */
  displayName: string;
  /** Message text content. */
  text: string;
  /** Channel-normalized attachments, with localPath populated after media is saved. */
  attachments?: {
    type: "image" | "video" | "audio" | "document" | "sticker" | "location" | "contact";
    url?: string;
    mimeType?: string;
    fileName?: string;
    caption?: string;
    localPath?: string;
  }[];
  /** Channel-specific message ID. */
  messageId: string;
  /** Provider-normalized message explicitly referenced by this reply. */
  replyTo?: MessageReplyReference;
  /** Optional pre-resolved person mapping (skips lookup). */
  personOverride?: MessageHandlerPersonOverride;
  /** Optional project working directory for this dedicated chat session. */
  workingDir?: string;
  /** The conversation's agent choice (`routing.agentName`), which the
   *  conversation stores. It wins over `linkedAgentName`. */
  routedAgentName?: string;
  /** Canonical id of the agent linked to the account the message arrived on.
   *  It answers a conversation that stores no agent choice of its own, and
   *  the conversation never stores it. When that agent is not loaded, nothing
   *  answers. Absent on an account that takes no link. */
  linkedAgentName?: string;
}

export interface MessageHandlerOutput {
  /** What action was taken on the message. */
  action:
    | "blocked"
    | "sent"
    | "no_response"
    | "pending_approval"
    | "rejected_by_envoy"
    | "sentinel_replied"
    | "sentinel_ignored";
  /** Agent response text, if one was generated. */
  response?: string;
  /** Reason for the action taken (e.g. block or rejection reason). */
  reason?: string;
}
