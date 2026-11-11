// The rows that record each agent session (`rome_sessions`, and the agent
// session's own row in `sessions`), for chats on every platform. Vocabulary:
// docs/domains/agents.md and docs/domains/chats.md#chat.
//
// Webchat reads and lists these rows for the dashboard, and Connections and
// Agent write them through here, so neither depends on Webchat.

import type { DeviceFolder } from "@rome/api-types/devices";
import { isCoreMainAgentId, type RomeSessionType } from "@rome-os/app-runtime";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { ChatRef } from "../chats/storage/place.js";
import type { DrizzleDb } from "../db/index.js";
import { romeSessions, sessions } from "../db/schema.js";
import { channelChatId, storedSessionType, withSessionKind } from "../db/session-kind.js";
import { firstPlacementSecond, placedCreatedAt } from "../db/speaker-placement.js";
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "../webchat/constants.js";

type SessionRow = typeof romeSessions.$inferSelect;

/**
 * What a child session (a fork, a subagent), or a session made to serve a
 * turn of a chat, takes from that chat's row beyond its owner. The context
 * that decides who may open a chat supplies it.
 */
export interface ChildSessionInheritance {
  /** The trigger kind a session under `parent` is marked with, or null to keep
   *  its own. */
  triggerKindUnder(parent: SessionRow): string | null;
}

export type SessionNameChangedListener = (event: { sessionId: string; name: string }) => void;

export interface EnsureRomeSessionInput {
  id: string;
  type: RomeSessionType;
  name: string;
  agentName: string | null;
  projectName?: string;
  projectPath?: string | null;
  /** A fork chat keeps the folder of the chat it branched from. */
  deviceFolder?: DeviceFolder | null;
  sourceChannel?: string | null;
  sourceThreadId?: string | null;
  sourceThreadName?: string | null;
  sourceThreadType?: "private" | "group" | string | null;
  trigger?: RomeAgentTraceTriggerMetadata;
  /** Lineage for 'fork' sessions: the rome session the fork branched from. */
  parentSessionId?: string | null;
  /**
   * The dashboard chat a session serves a turn of without being its child,
   * as an agent an action starts from that chat. The session takes that
   * chat's owner and privacy as a child does, and is not made when the chat
   * is gone.
   */
  servesSessionId?: string | null;
  /** The turn on the parent session that triggered the fork. */
  parentTurnId?: string | null;
}

export interface RomeAgentTraceTriggerMetadata {
  triggerKind?: string | null;
  triggerName?: string | null;
  triggerActionName?: string | null;
  triggerExecutionId?: string | null;
  rootActionExecutionId?: string | null;
  parentActionExecutionId?: string | null;
}

/** The update that moves a session's activity up to `at`, never back. */
export function advanceSessionActivitySet(at: Date) {
  const timestamp = Math.floor(at.getTime() / 1000);
  return {
    activityAt: sql<Date>`case when ${romeSessions.activityAt} < ${timestamp} then ${timestamp} else ${romeSessions.activityAt} end`,
  };
}

export class SessionRecords {
  private readonly nameChangedListeners = new Set<SessionNameChangedListener>();

  constructor(
    private readonly db: DrizzleDb,
    private readonly inheritance: ChildSessionInheritance,
  ) {}

  /** Told when a session takes the name its channel reported for it. */
  onNameChanged(listener: SessionNameChangedListener): () => void {
    this.nameChangedListeners.add(listener);
    return () => {
      this.nameChangedListeners.delete(listener);
    };
  }

  /**
   * Saves a session row unless it exists. A child session (a fork, a
   * subagent: anything naming `parentSessionId`), and a session made to serve
   * a turn of a chat (`servesSessionId`), is saved in one transaction with
   * the read of that chat, and takes its owner and the trigger kind
   * {@link ChildSessionInheritance} gives it. A chat that no longer exists makes this throw and saves nothing,
   * so no such session is ever made without them.
   */
  async ensureRomeSession(input: EnsureRomeSessionInput): Promise<void> {
    const now = new Date();
    // A chat is a channel row on the webchat channel, at its own address,
    // whichever of the two types the caller names it by.
    const chat =
      input.type === "webchat" || (input.type === "channel" && input.sourceChannel === "webchat");
    const row = (parent: SessionRow | null) => ({
      id: input.id,
      ownerKey: parent?.ownerKey ?? null,
      name: input.name,
      personaId: null,
      projectName: input.projectName ?? DEFAULT_WEBCHAT_PROJECT_NAME,
      projectPath: input.projectPath ?? null,
      deviceFolder: input.deviceFolder ?? null,
      largeModelSelection: null,
      agentName: input.agentName,
      type: storedSessionType(input.type),
      sourceChannel: chat ? "webchat" : (input.sourceChannel ?? null),
      sourceThreadId: chat ? input.id : (input.sourceThreadId ?? null),
      sourceThreadName: input.sourceThreadName ?? null,
      sourceThreadType: input.sourceThreadType ?? null,
      triggerKind:
        (parent && this.inheritance.triggerKindUnder(parent)) ?? input.trigger?.triggerKind ?? null,
      triggerName: input.trigger?.triggerName ?? null,
      triggerActionName: input.trigger?.triggerActionName ?? null,
      triggerExecutionId: input.trigger?.triggerExecutionId ?? null,
      rootActionExecutionId: input.trigger?.rootActionExecutionId ?? null,
      parentActionExecutionId: input.trigger?.parentActionExecutionId ?? null,
      parentSessionId: input.parentSessionId ?? null,
      parentTurnId: input.parentTurnId ?? null,
      handoffSpec: null,
      createdAt: now,
      activityAt: now,
      lastSeenActivityAt: chat ? now : null,
    });
    const parentId = input.parentSessionId ?? input.servesSessionId;
    if (!parentId) {
      await this.db.insert(romeSessions).values(row(null)).onConflictDoNothing({
        target: romeSessions.id,
      });
      return;
    }
    // `transaction` is synchronous on better-sqlite3: nothing can delete the
    // parent between this read and the insert.
    this.db.transaction((tx) => {
      const parent = tx.select().from(romeSessions).where(eq(romeSessions.id, parentId)).get();
      if (!parent) throw new Error(`Parent Rome session "${parentId}" was not found`);
      tx.insert(romeSessions)
        .values(row(parent))
        .onConflictDoNothing({ target: romeSessions.id })
        .run();
    });
  }

  async ensureChannelChat(input: {
    channel: string;
    threadId: string;
    parentThreadId?: string;
    threadName?: string;
    threadType?: "private" | "group";
    agentName: string;
    projectName?: string;
    projectPath?: string;
    /** Where the session stands in Chats, set on its row when given: the
     *  chat, the one of Rome's accounts that heard it, and when, which the
     *  session's activity moves up to. Only Chats' own recording passes it,
     *  from the Chats switch on. */
    speaker?: { chat: ChatRef; accountId: string; at: Date };
  }): Promise<{ id: string; agentName: string | null }> {
    const opened = await this.openChannelChat(input);
    const { speaker } = input;
    if (speaker) {
      const thread =
        input.parentThreadId && input.parentThreadId !== input.threadId ? input.threadId : null;
      // A session first standing in its chat starts just before the line
      // that opened it, so a catch-up, which reads what was said after the
      // session's second, reads that line too once it wakes no agent. Where
      // the account spoke there first, as a send that started the chat, the
      // session starts before that line instead, so it reads what it said.
      // Asked only while the session stands nowhere yet: once placed, its
      // start no longer moves, and every message heard asks this again.
      const placed = this.db
        .select({ chatId: romeSessions.chatId })
        .from(romeSessions)
        .where(eq(romeSessions.id, opened.id))
        .get()?.chatId;
      const heardSecond =
        placed == null
          ? firstPlacementSecond(
              this.db,
              { chatId: speaker.chat.id, threadId: thread, accountId: speaker.accountId },
              speaker.at,
            )
          : Math.floor(speaker.at.getTime() / 1000);
      await this.db
        .update(romeSessions)
        .set({
          createdAt: placedCreatedAt(heardSecond),
          chatId: speaker.chat.id,
          chatPlatform: speaker.chat.platform,
          threadId: thread,
          accountId: speaker.accountId,
          ...advanceSessionActivitySet(speaker.at),
        })
        .where(eq(romeSessions.id, opened.id));
    }
    return opened;
  }

  private async openChannelChat(input: {
    channel: string;
    threadId: string;
    parentThreadId?: string;
    threadName?: string;
    threadType?: "private" | "group";
    agentName: string;
    projectName?: string;
    projectPath?: string;
    speaker?: { chat: ChatRef; accountId: string; at: Date };
  }): Promise<{ id: string; agentName: string | null }> {
    const parent =
      input.parentThreadId && input.parentThreadId !== input.threadId
        ? await this.ensureChannelChat({
            ...input,
            threadId: input.parentThreadId,
            parentThreadId: undefined,
            threadName: undefined,
            threadType: "group",
          })
        : null;
    const found = await this.findChannelConversation(input.channel, input.threadId);
    if (found && input.threadName) {
      await this.backfillChannelConversationName(found, input, input.threadName);
    }
    const existing = found && { id: found.id, agentName: found.agentName };
    if (existing) {
      if (!parent) return existing;
      // A native thread has its own model session but not its own routing
      // policy. Keep the derived row in sync with the parent on admission.
      await this.db
        .update(romeSessions)
        .set({ parentSessionId: parent.id, agentName: parent.agentName })
        .where(eq(romeSessions.id, existing.id));
      return { ...existing, agentName: parent.agentName };
    }
    // Only the dashboard opens a chat, through `createSession`. A webchat
    // address that names no chat is a deleted chat or a handoff, not a new one.
    if (input.channel === "webchat") {
      throw new Error(`No chat at webchat address ${input.threadId}`);
    }

    const id = channelChatId(input.channel, input.threadId);
    const now = new Date();
    await this.db
      .insert(romeSessions)
      .values({
        id,
        name: input.threadName ?? `${input.channel}:${input.threadId}`,
        personaId: null,
        projectName: input.projectName ?? DEFAULT_WEBCHAT_PROJECT_NAME,
        projectPath: input.projectPath ?? null,
        largeModelSelection: null,
        agentName: parent
          ? parent.agentName
          : isCoreMainAgentId(input.agentName)
            ? null
            : input.agentName,
        type: "channel",
        sourceChannel: input.channel,
        sourceThreadId: input.threadId,
        sourceThreadName: input.threadName ?? null,
        sourceThreadType: input.threadType ?? null,
        parentSessionId: parent?.id ?? null,
        createdAt: now,
        activityAt: now,
        lastSeenActivityAt: null,
      })
      .onConflictDoNothing();

    const conversation = await this.findChannelConversation(input.channel, input.threadId);
    if (!conversation) {
      throw new Error(`Failed to resolve conversation ${input.channel}:${input.threadId}`);
    }
    return { id: conversation.id, agentName: conversation.agentName };
  }

  /** Fill in a conversation's name when the row holds only its address, as
   *  rows created before the channel reported a name do. A name already
   *  recorded is kept, so email subjects and guardian renames stay put. */
  private async backfillChannelConversationName(
    row: { id: string; name: string; sourceThreadName: string | null },
    address: { channel: string; threadId: string },
    threadName: string,
  ): Promise<void> {
    const placeholders = [address.threadId, `${address.channel}:${address.threadId}`];
    const sourceMissing =
      row.sourceThreadName === null || placeholders.includes(row.sourceThreadName);
    const nameMissing = placeholders.includes(row.name);
    if (!sourceMissing && !nameMissing) return;
    // Each column is rewritten only while it still holds a placeholder, so a
    // concurrent message that already filled it in leaves nothing to change.
    const updated = await this.db
      .update(romeSessions)
      .set({
        sourceThreadName: sql`case when ${romeSessions.sourceThreadName} is null or ${inArray(romeSessions.sourceThreadName, placeholders)} then ${threadName} else ${romeSessions.sourceThreadName} end`,
        name: sql`case when ${inArray(romeSessions.name, placeholders)} then ${threadName} else ${romeSessions.name} end`,
      })
      .where(
        and(
          eq(romeSessions.id, row.id),
          or(
            isNull(romeSessions.sourceThreadName),
            inArray(romeSessions.sourceThreadName, placeholders),
            inArray(romeSessions.name, placeholders),
          ),
        ),
      )
      .returning({ name: romeSessions.name });
    if (nameMissing && updated[0]?.name === threadName) {
      for (const listener of this.nameChangedListeners) {
        listener({ sessionId: row.id, name: threadName });
      }
    }
  }

  /** The conversation at channel address `threadId` on `channel`, by the id
   *  {@link channelChatId} gives it, or null when none is there. */
  private async findChannelConversation(
    channel: string,
    threadId: string,
  ): Promise<{
    id: string;
    agentName: string | null;
    name: string;
    sourceThreadName: string | null;
  } | null> {
    const rows = await this.db
      .select({
        id: romeSessions.id,
        agentName: romeSessions.agentName,
        name: romeSessions.name,
        sourceThreadName: romeSessions.sourceThreadName,
      })
      .from(romeSessions)
      .where(
        and(
          eq(romeSessions.id, channelChatId(channel, threadId)),
          eq(romeSessions.type, "channel"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getSession(id: string) {
    const rows = await this.db.select().from(romeSessions).where(eq(romeSessions.id, id));
    return rows[0] ? withSessionKind(rows[0]) : null;
  }

  /**
   * Record that a chat has an agent session, on the session's stored row.
   * Answers the other chat it replaced, if any. With `replace: false`, a row
   * that already names a chat keeps it.
   */
  async recordSessionInChat(
    sessionId: string,
    chatId: string,
    options: { replace?: boolean } = {},
  ): Promise<string | null> {
    return this.db.transaction((tx) => {
      const row = tx
        .select({ chatId: sessions.chatId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get();
      if (!row || row.chatId === chatId) return null;
      if (row.chatId !== null && options.replace === false) return null;
      tx.update(sessions).set({ chatId }).where(eq(sessions.id, sessionId)).run();
      return row.chatId;
    });
  }
}
