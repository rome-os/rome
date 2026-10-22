// The chat record's writes (docs/domains/chats.md). Callers hand over the
// conversation row a message was stored against today. This module works out
// which chat, and which thread of it, that row stands for, and appends the
// message there.

import { eq, inArray } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../index.js";
import {
  channels,
  chatAccounts,
  chatMessages,
  chatThreads,
  chats,
  romeSessions,
} from "../schema.js";

type Exec = DrizzleDb | DrizzleTx;
type SessionRow = Pick<
  typeof romeSessions.$inferSelect,
  | "id"
  | "type"
  | "sourceChannel"
  | "sourceThreadId"
  | "sourceThreadType"
  | "parentSessionId"
  | "agentName"
>;

/** The chat, and the thread of it, that one conversation row stands for. */
export interface ChatPlace {
  chatId: string;
  platform: string;
  platformChatId: string;
  kind: "dm" | "group" | "dashboard";
  /** The Rome account the row belongs to. Null for the dashboard chat. */
  channel: string | null;
  /** Named only for a direct message, whose id carries it. */
  romeChannel: string | null;
  platformThreadId: string | null;
}

export interface ChatMessageInput {
  /** The conversation row the message was stored against. */
  sessionId: string;
  /** The platform's id for the message. The dashboard chat's own message id. */
  platformMessageId: string;
  direction: "to_rome" | "from_rome";
  /** The message parts as JSON, in the shape the chat surfaces exchange. */
  parts: string;
  senderId?: string | null;
  senderName?: string | null;
  replyToPlatformMessageId?: string | null;
  saidAt: Date;
  /** Record only when the row is the dashboard chat. For writers that also see
   *  a platform conversation's agent transcript, which is not what was said there. */
  dashboardOnly?: boolean;
}

const DASHBOARD_PLATFORM = "rome";
const DASHBOARD_CHANNEL = "webchat";

const sessionColumns = {
  id: romeSessions.id,
  type: romeSessions.type,
  sourceChannel: romeSessions.sourceChannel,
  sourceThreadId: romeSessions.sourceThreadId,
  sourceThreadType: romeSessions.sourceThreadType,
  parentSessionId: romeSessions.parentSessionId,
  agentName: romeSessions.agentName,
};

function sessionRow(exec: Exec, id: string): SessionRow | undefined {
  return exec.select(sessionColumns).from(romeSessions).where(eq(romeSessions.id, id)).get();
}

function platformOf(exec: Exec, channel: string): string {
  const row = exec
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.id, channel))
    .get();
  return row?.platform ?? channel;
}

/**
 * The chat a conversation row stands for, or null when the row is not a chat:
 * action, subagent and handoff conversations are an agent's work, not a place
 * people talk.
 *
 * A native thread (a Discord or Slack thread, stored today as a conversation of
 * its own with the channel as parent) is placed in its parent's chat.
 */
export function chatPlaceOf(exec: Exec, sessionId: string): ChatPlace | null {
  const row = sessionRow(exec, sessionId);
  if (!row || row.type !== "channel" || !row.sourceChannel || !row.sourceThreadId) return null;

  if (row.sourceChannel === DASHBOARD_CHANNEL) {
    return {
      chatId: `${DASHBOARD_PLATFORM}:${row.id}`,
      platform: DASHBOARD_PLATFORM,
      platformChatId: row.id,
      kind: "dashboard",
      channel: null,
      romeChannel: null,
      platformThreadId: null,
    };
  }

  const channel = row.sourceChannel;
  const parent = row.parentSessionId ? sessionRow(exec, row.parentSessionId) : undefined;
  const chatRow =
    parent?.type === "channel" && parent.sourceChannel === channel && parent.sourceThreadId
      ? parent
      : row;
  const platform = platformOf(exec, channel);
  const platformChatId = chatRow.sourceThreadId!;
  const dm = chatRow.sourceThreadType === "private";
  return {
    chatId: dm ? `${platform}:${channel}:${platformChatId}` : `${platform}:${platformChatId}`,
    platform,
    platformChatId,
    kind: dm ? "dm" : "group",
    channel,
    romeChannel: dm ? channel : null,
    platformThreadId: chatRow === row ? null : row.sourceThreadId,
  };
}

/**
 * Append one message to the chat record. Idempotent: a message already
 * recorded for its chat, by the same platform message id, is left as it was,
 * so two of Rome's accounts in one group record a message the group said once.
 * Does nothing for a row that is not a chat. Run it inside the transaction
 * that stores the message today, so the two records cannot disagree.
 */
export function recordChatMessage(tx: DrizzleTx, input: ChatMessageInput): void {
  const place = chatPlaceOf(tx, input.sessionId);
  if (!place || (input.dashboardOnly && place.kind !== "dashboard")) return;
  const now = new Date();

  tx.insert(chats)
    .values({
      id: place.chatId,
      platform: place.platform,
      platformChatId: place.platformChatId,
      kind: place.kind,
      romeChannel: place.romeChannel,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
  if (place.channel) {
    tx.insert(chatAccounts)
      .values({ chatId: place.chatId, channel: place.channel, firstSeenAt: now })
      .onConflictDoNothing()
      .run();
  }
  if (place.platformThreadId) {
    tx.insert(chatThreads)
      .values({ chatId: place.chatId, platformThreadId: place.platformThreadId, createdAt: now })
      .onConflictDoNothing()
      .run();
  }

  // On a platform the account said it, whichever agent the turn ran. The
  // dashboard chat has no account, so its replies name their agent.
  const agentName =
    place.kind === "dashboard" && input.direction === "from_rome"
      ? (sessionRow(tx, input.sessionId)?.agentName ?? "main")
      : null;
  tx.insert(chatMessages)
    .values({
      id: `${place.chatId}#${input.platformMessageId}`,
      chatId: place.chatId,
      platformThreadId: place.platformThreadId,
      platformMessageId: input.platformMessageId,
      direction: input.direction,
      channel: place.channel,
      senderId: input.senderId ?? null,
      senderName: input.senderName ?? null,
      agentName,
      parts: input.parts,
      replyToPlatformMessageId: input.replyToPlatformMessageId ?? null,
      saidAt: input.saidAt,
    })
    .onConflictDoNothing()
    .run();
}

/** Remove the dashboard chats with these conversation ids, with everything said in them. */
export function deleteDashboardChatRecords(tx: DrizzleTx, sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  const ids = sessionIds.map((id) => `${DASHBOARD_PLATFORM}:${id}`);
  tx.delete(chatMessages).where(inArray(chatMessages.chatId, ids)).run();
  tx.delete(chatThreads).where(inArray(chatThreads.chatId, ids)).run();
  tx.delete(chatAccounts).where(inArray(chatAccounts.chatId, ids)).run();
  tx.delete(chats).where(inArray(chats.id, ids)).run();
}
