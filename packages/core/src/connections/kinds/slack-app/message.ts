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
  /** Workspaces Slack names on it. In a channel shared with another
   *  workspace (Slack Connect) an author can be from either: `user_team` is
   *  the author's, while `team` and `source_team` are the event's and can
   *  differ from the author's. */
  user_team?: string;
  team?: string;
  source_team?: string;
  /** Its last edit, when it was edited. */
  edited?: { ts?: string };
}

/** A member as Slack's directory names them. */
export interface SlackMember extends SlackUserName {
  /** The member's own workspace. */
  teamId?: string;
}

/** The text of a message that was only the app's mention. */
const BARE_MENTION = "@Rome";

/** Subtypes someone said: a plain message has none. */
const SAID = new Set(["file_share", "thread_broadcast", "bot_message"]);

/** Whether a message of subtype `subtype` is one someone said. */
export function isSaid(subtype: string | undefined): boolean {
  return !subtype || SAID.has(subtype);
}

/** Who said `wire`: its user, or for a bot or workflow that posts with no
 *  user, the bot. */
export function authorOf(wire: Pick<SlackWireMessage, "user" | "bot_id">): string | undefined {
  return wire.user ?? wire.bot_id;
}

/** Whether `wire` sits in its chat's timeline, the messages Slack's
 *  conversations.history answers: not a reply inside a thread, unless it was
 *  also sent to the chat. */
export function inTimeline(wire: SlackWireMessage): boolean {
  return !wire.thread_ts || wire.thread_ts === wire.ts || wire.subtype === "thread_broadcast";
}

/**
 * `wire` as Rome reads it, or null when nobody said it (a join, an edit) or it
 * holds no text. A message the app's bot said reads as outbound. Throws
 * {@link SlackWorkspaceUnknown} while its author's workspace is not known, so
 * a history read fails and is read again rather than name the author wrongly.
 */
export function slackMessage(
  context: { channel: string; teamId: string; botUserId: string; chatId: string },
  wire: SlackWireMessage,
  name: SlackMember = {},
): ChannelMessage | null {
  if (!isSaid(wire.subtype)) return null;
  const author = authorOf(wire);
  if (!author || typeof wire.text !== "string") return null;
  // A message that was only the app's mention keeps that mention, so a bare
  // @Rome is still heard: Rome drops a message with no text.
  const mentionsApp = wire.text.includes(`<@${context.botUserId}`);
  const text = decodeSlackText(wire.text, context.botUserId) || (mentionsApp ? BARE_MENTION : "");
  if (!text) return null;
  const isDm = context.chatId.startsWith("D");
  return {
    channel: context.channel,
    direction: author === context.botUserId ? "outbound" : "inbound",
    chatId: context.chatId as ChatId,
    messageId: slackMessageId(wire.ts, wire.thread_ts),
    // Slack user ids are per workspace, so an author from another workspace
    // is named under their own.
    senderId: slackSenderId(authorWorkspace(wire, name, context.teamId), author),
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

/** A message whose author Slack placed only in an Enterprise Grid org, while
 *  Slack's directory has not named their workspace. The author has no
 *  account id yet, so the message is not handed over until it does. */
export class SlackWorkspaceUnknown extends Error {
  constructor(readonly author: string) {
    super(
      `Slack has not said which workspace author ${author} belongs to yet. Read again shortly.`,
    );
  }
}

/** The workspace `wire`'s author belongs to: the one `user_team` names,
 *  unless it names an Enterprise Grid org (`E…`). A message that names no
 *  workspace but the app's own is from the app's workspace. Otherwise Slack's
 *  directory names the member's workspace, and until it does the workspace is
 *  not known. The message's own words come first, so an author keeps one id
 *  whether or not the directory answered. A bot, which the directory does
 *  not list, keeps what the message names. */
function authorWorkspace(wire: SlackWireMessage, member: SlackMember, own: string): string {
  if (!wire.user) return wire.user_team ?? wire.team ?? own;
  if (wire.user_team?.startsWith("T")) return wire.user_team;
  const named = [wire.user_team, wire.team, wire.source_team].filter((team) => team !== undefined);
  if (named.every((team) => team === own)) return own;
  if (member.teamId?.startsWith("T")) return member.teamId;
  throw new SlackWorkspaceUnknown(wire.user);
}
