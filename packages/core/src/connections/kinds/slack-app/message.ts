// One message of a Slack chat as Rome reads it, built the same way whether the
// app heard it as an event or read it from Slack's history, so a reader can
// tell the two are one.

import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import {
  decodeSlackText,
  slackMessageId,
  slackSenderId,
  type SlackUserName,
} from "../slack/slack.js";

/** A Slack message as an event or a history page spells it, in the fields
 *  read here. */
export interface SlackWireMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  subtype?: string;
}

/** Subtypes someone said: a plain message has none. */
const SAID = new Set(["file_share", "thread_broadcast", "bot_message"]);

/** Whether `wire` sits in its chat's timeline, the messages Slack's
 *  conversations.history answers: not a reply inside a thread, unless it was
 *  also sent to the chat. */
export function inTimeline(wire: SlackWireMessage): boolean {
  return !wire.thread_ts || wire.thread_ts === wire.ts || wire.subtype === "thread_broadcast";
}

/**
 * `wire` as Rome reads it, or null when nobody said it (a join, an edit) or it
 * holds no text. A message the app's bot said reads as outbound.
 */
export function slackMessage(
  context: { channel: string; teamId: string; botUserId: string; chatId: string },
  wire: SlackWireMessage,
  name: SlackUserName = {},
): ChannelMessage | null {
  if (wire.subtype && !SAID.has(wire.subtype)) return null;
  const author = wire.user;
  if (!author || typeof wire.text !== "string") return null;
  const text = decodeSlackText(wire.text, context.botUserId);
  if (!text) return null;
  const isDm = context.chatId.startsWith("D");
  return {
    channel: context.channel,
    direction: author === context.botUserId ? "outbound" : "inbound",
    chatId: context.chatId as ChatId,
    messageId: slackMessageId(wire.ts, wire.thread_ts),
    senderId: slackSenderId(context.teamId, author),
    ...(name.displayName ? { senderDisplayName: name.displayName } : {}),
    ...(name.username ? { senderUsername: name.username } : {}),
    text,
    attachments: [],
    timestamp: new Date(Number.parseFloat(wire.ts) * 1_000),
    ...(wire.thread_ts && wire.thread_ts !== wire.ts
      ? { replyTo: { messageId: wire.thread_ts } }
      : {}),
    thread: { kind: isDm ? "dm" : "group" },
  };
}
